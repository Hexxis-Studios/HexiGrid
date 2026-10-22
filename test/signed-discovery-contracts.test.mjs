import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';
import { agentLinkOrientation } from '../lib/agent-link-orientation.mjs';

test('signed search cards show executable primary endpoints and the related methods', async () => {
  const window = {};
  runInNewContext(await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8'), { window });
  const manifest = agentInterfaceManifest();
  for (const [query, method, path] of [
    ['signedHarnessJobs', 'POST', '/agent-link/v1/harness-jobs'],
    ['signedCodexDirectory', 'GET', '/agent-link/v1/codex/chats'],
    ['signedContinuityTransfer', 'POST', '/agent-link/v1/continuity']
  ]) {
    const entries = window.HexiGridViewRenderers.agentCatalogEntries(manifest, { query, authentication: 'signed' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, path);
    assert.equal(entries[0].action.method, method);
  }
});

test('signed discovery catalog describes exact Codex, harness, and continuity contracts', () => {
  const { actions } = agentInterfaceManifest();
  assert.ok(actions.updateAgent.optional.includes('model'));
  assert.ok(actions.trainWakeWord.optional.includes('phrase'));
  assert.match(actions.updateSettings.note, /configured provider routes require local:true/);
  assert.doesNotMatch(actions.updateSettings.note, /not filtered by free-only/);
  const codex = actions.signedCodexDirectory;
  assert.equal(codex.authentication, 'signed Link');
  assert.deepEqual(codex.requiredCapabilities, ['messages']);
  assert.equal(codex.requiredTrustLevel, 'owner');
  assert.equal(codex.requiredCondition, 'codexRelayNamedTargetAllowed');
  assert.equal(codex.directory.chats.method, 'GET');
  assert.equal(codex.directory.chats.path, '/agent-link/v1/codex/chats');
  assert.equal(codex.directory.projects.path, '/agent-link/v1/codex/projects');
  assert.deepEqual(codex.createChat.required, ['projectId', 'prompt']);
  assert.equal(codex.createChat.projectId, 'existing project only');
  assert.equal(codex.createChat.promptMaximumCharacters, 10000);
  assert.equal(codex.createChat.titleMaximumCharacters, 160);
  assert.equal(codex.createChat.policyCapability, 'external_write');
  assert.equal(codex.createChat.risk, 'high');
  assert.match(codex.note, /Project creation is not exposed/);
  assert.deepEqual(codex.delivery.targetAlternatives, ['metadata.codexThreadName', 'metadata.codexThreadId']);
  assert.equal(codex.delivery.method, 'POST');
  assert.equal(codex.delivery.path, '/agent-link/v1/messages');
  assert.deepEqual(codex.delivery.required, ['clientMessageId']);
  assert.equal(codex.delivery.body.metadata.codexThreadName, '<exact existing chat name>');
  assert.match(codex.delivery.note, /not both/);
  assert.match(codex.note, /metadata\.codexThreadId/);
  assert.doesNotMatch(codex.note, /targetName|targetThreadId/);

  const harness = actions.signedHarnessJobs;
  assert.equal(harness.authentication, 'signed Link');
  assert.equal(harness.capability, 'harness-jobs');
  assert.equal(harness.start.path, '/agent-link/v1/harness-jobs');
  assert.deepEqual(harness.start.required, ['prompt']);
  assert.deepEqual(harness.start.optional, ['approved', 'clientJobId']);
  assert.equal(harness.start.policyCapability, 'run_tools');
  assert.equal(harness.start.risk, 'high');
  assert.equal(harness.get.path, '/agent-link/v1/harness-jobs/{jobId}');
  assert.equal(harness.cancel.path, '/agent-link/v1/harness-jobs/{jobId}/cancel');
  assert.deepEqual(harness.cancel.body, {});
  assert.match(harness.note, /exact Link/);
  assert.match(harness.note, /encrypted locally/);
  assert.match(harness.note, /without automatic replay/);

  const continuity = actions.signedContinuityTransfer;
  assert.equal(continuity.authentication, 'signed Link');
  assert.equal(continuity.capability, 'continuity-export');
  assert.equal(continuity.submitSnapshot.method, 'POST');
  assert.equal(continuity.submitSnapshot.path, '/agent-link/v1/continuity');
  assert.match(continuity.submitSnapshot.body, /8 MiB/);
  assert.equal(continuity.requestExport.path, '/agent-link/v1/continuity/export-request');
  assert.deepEqual(continuity.requestExport.body, {});
  assert.equal(continuity.getExportStatus.path, '/agent-link/v1/continuity/export-request/{requestId}');
  assert.match(continuity.note, /never create, authorize, or return encrypted package bytes/);
});

test('orientation hides signed discovery unless grants and declared conditions match', () => {
  const base = {
    id: 'link-local-test', agentId: 'agent-local-test', identity: { name: 'Test Link' },
    status: 'connected', capabilities: ['messages', 'harness-jobs', 'continuity-export']
  };
  const settings = { codexRelay: { enabled: true, linkId: base.id, allowNamedThreads: true } };
  const owner = agentLinkOrientation({ ...base, trustLevel: 'owner' }, settings);
  const methods = (capability) => owner.available.find((item) => item.capability === capability)?.methods || [];
  assert.deepEqual(methods('messages').map(({ path }) => path), [
    '/agent-link/v1/avatar/portrait', '/agent-link/v1/codex/chats', '/agent-link/v1/codex/projects', '/agent-link/v1/codex/chats'
  ]);
  assert.deepEqual(methods('harness-jobs').map(({ path }) => path), [
    '/agent-link/v1/harness-jobs', '/agent-link/v1/harness-jobs/{jobId}', '/agent-link/v1/harness-jobs/{jobId}/cancel'
  ]);
  assert.equal(methods('continuity-export').length, 3);
  const directory = methods('messages').find(method => method.path === '/agent-link/v1/codex/chats');
  assert.match(directory.guidance, /metadata\.codexThreadName or metadata\.codexThreadId/);
  assert.match(directory.guidance, /clientMessageId/);
  assert.doesNotMatch(directory.guidance, /targetName|targetThreadId/);

  const noCapabilities = agentLinkOrientation({ ...base, trustLevel: 'owner', capabilities: [] }, settings);
  assert.deepEqual(noCapabilities.available, []);
  const wrongRelay = agentLinkOrientation({ ...base, trustLevel: 'owner' }, { codexRelay: { ...settings.codexRelay, linkId: 'other-link' } });
  assert.equal(wrongRelay.available.find((item) => item.capability === 'messages')?.methods?.some(method => method.path.startsWith('/agent-link/v1/codex/')) || false, false);
  const scoped = agentLinkOrientation({ ...base, trustLevel: 'scoped' }, settings);
  assert.equal(scoped.available.find((item) => item.capability === 'messages')?.methods?.some(method => method.path.startsWith('/agent-link/v1/codex/')) || false, false);

  const exposed = JSON.stringify({ owner, catalog: agentInterfaceManifest().actions.signedCodexDirectory,
    harness: agentInterfaceManifest().actions.signedHarnessJobs, continuity: agentInterfaceManifest().actions.signedContinuityTransfer });
  assert.doesNotMatch(exposed, /(tokenHash|tokenValue|ownerToken|passwordHash|apiKey|cookieValue)/i);
});
