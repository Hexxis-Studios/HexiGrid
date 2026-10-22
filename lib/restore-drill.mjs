import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptBackup } from './backup.mjs';
import { openContinuityPackage } from './continuity-transfer.mjs';
import { DatedMemoryStore } from './dated-memory.mjs';
import { restorePortableFiles } from './portable-files.mjs';
import { createWholeAppManifest, verifyWholeAppManifest, wholeAppBackupAreas } from './whole-app-backup.mjs';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function stateForDrill(payload) {
  const state = { ...payload, backup: { ...payload.backup } };
  delete state.privateFiles;
  if (state.backup?.format !== 'hexigrid-local-data' || state.backup.version !== 3) {
    throw new Error('The restore drill requires a whole-app snapshot.');
  }
  delete state.backup.manifest;
  return JSON.parse(JSON.stringify(state));
}

function validateChecks(checks) {
  const validList = (entries) => Array.isArray(entries) && entries.length > 0 && entries.length <= 100 &&
    entries.every((entry) => entry && typeof entry === 'object' &&
      /^memory-[0-9a-f-]{36}$/.test(entry.id) && /^[0-9a-f]{64}$/.test(entry.textSha256));
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) ||
      typeof checks.agentId !== 'string' || !checks.agentId ||
      typeof checks.name !== 'string' || !checks.name ||
      !validList(checks.anchors) || !validList(checks.keyFacts)) {
    throw new Error('Restore drill identity checks require an agent, anchors, and key facts with text SHA-256 hashes.');
  }
  const ids = [...checks.anchors, ...checks.keyFacts].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('Restore drill identity checks contain duplicate memory IDs.');
}

// The caller supplies an encrypted envelope. This drill never reads a backup
// directory, changes live state, activates a lineage, or invokes a connector.
export async function drillEncryptedBackup({ envelope, passphrase, checks } = {}) {
  if (envelope?.format === 'hexigrid-continuity') {
    if (checks !== undefined) throw new Error('Agent identity checks require a whole-app backup with dated memory.');
    const opened = openContinuityPackage(envelope, passphrase);
    return {
      format: 'continuity-package', verified: true, checkOnly: true, schemaVersion: opened.manifest.schemaVersion,
      complete: opened.completeness.complete, contentFiles: opened.contentFiles.length,
      categoriesVerified: Object.keys(opened.completeness.categories).length
    };
  }

  if (checks !== undefined) validateChecks(checks);
  const payload = decryptBackup(envelope, passphrase);
  const verification = verifyWholeAppManifest(payload);
  if (verification.legacy) throw new Error('A restore drill requires a whole-app backup with an integrity manifest.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-restore-drill-'));
  try {
    const statePath = path.join(directory, 'control-room-state.json');
    await writeFile(statePath, JSON.stringify(stateForDrill(payload)), { mode: 0o600, flag: 'wx' });
    const restoredState = JSON.parse(await readFile(statePath, 'utf8'));
    if (!Array.isArray(restoredState.agents) || !Array.isArray(restoredState.rooms) ||
        createWholeAppManifest({ ...restoredState, privateFiles: payload.privateFiles }).stateSha256 !== verification.manifest.stateSha256) {
      throw new Error('The isolated restore failed its state readback.');
    }
    const roots = Object.fromEntries(wholeAppBackupAreas.map((area) => [area, path.join(directory, area)]));
    const restored = await restorePortableFiles(payload.privateFiles, roots);
    for (const file of payload.privateFiles.files) {
      const bytes = await readFile(path.join(roots[file.area], file.path));
      if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('The isolated restore failed its byte comparison.');
    }
    let checkResult;
    if (checks !== undefined) {
      const agent = restoredState.agents.find((item) => item?.id === checks.agentId);
      if (!agent || agent.name !== checks.name) throw new Error('The isolated restore failed its agent identity check.');
      const lineageId = agent.continuityLineage?.id;
      if (!lineageId) throw new Error('The isolated restore is missing the agent memory lineage.');
      const store = new DatedMemoryStore({ root: roots['dated-memory'] });
      const selected = [...checks.anchors, ...checks.keyFacts].map((entry) => entry.id);
      const found = await store.getByIds({ lineageId, ids: selected });
      for (const expected of checks.anchors) {
        const memory = found.get(expected.id);
        if (!memory || !['active', 'conditional'].includes(memory.status) || memory.identityAnchor !== true ||
            digest(memory.text) !== expected.textSha256) {
          throw new Error('The isolated restore failed an identity anchor check.');
        }
      }
      for (const expected of checks.keyFacts) {
        const memory = found.get(expected.id);
        if (!memory || !['active', 'conditional'].includes(memory.status) ||
            digest(memory.text) !== expected.textSha256) throw new Error('The isolated restore failed a key fact check.');
      }
      checkResult = { passed: 2 + checks.anchors.length + checks.keyFacts.length,
        total: 2 + checks.anchors.length + checks.keyFacts.length };
    }
    return { format: 'whole-app-snapshot', verified: true, stateReadBack: true,
      restoredFiles: restored.files, restoredBytes: restored.bytes,
      areas: payload.privateFiles.areas.length, ...(checkResult ? { checks: checkResult } : {}) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
