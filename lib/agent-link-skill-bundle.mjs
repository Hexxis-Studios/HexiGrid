import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AGENT_LINK_SKILL_VERSION = 52;

const SKILL_FILES = [
  'SKILL.md',
  'references/continuity-schema.md',
  'scripts/link_client.py',
  'scripts/companion_client.mjs',
  'lib/companion-client.mjs',
  'lib/companion-connection.mjs',
  'lib/voice-agent-runtime.mjs'
];

export async function agentLinkSkillBundle(skillRoot, projectRoot) {
  const files = [];
  for (const name of SKILL_FILES) {
    const sourceRoot = name.startsWith('lib/') ? projectRoot : skillRoot;
    const content = await fs.readFile(path.join(sourceRoot, ...name.split('/')), 'utf8');
    files.push({ path: name, sha256: crypto.createHash('sha256').update(content).digest('hex'), content });
  }
  return {
    name: 'hexigrid-link',
    version: AGENT_LINK_SKILL_VERSION,
    install: 'Create one hexigrid-link skill directory and write each file at its listed relative path. Verify every SHA-256 digest, then read SKILL.md.',
    files
  };
}
