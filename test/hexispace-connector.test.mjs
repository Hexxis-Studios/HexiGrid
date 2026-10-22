import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HEXISPACE_SCOPES, createHexiSpacePairing, approveHexiSpacePairing, authenticateHexiSpace, hexispaceLinkSummaries, linkedAgentSummary, publicManifest, normalizeHexiSpaceConnector, revokeHexiSpaceLinkByToken } from '../lib/hexispace-connector.mjs';
import { hexispaceTaskSummaries, isHexiSpaceTaskOwnedByLink, normalizeHexiSpaceTaskSchedule } from '../lib/hexispace-tasks.mjs';

test('HexiSpace manifest advertises scoped mailbox and artifact capabilities without credentials', () => {
  assert.equal(HEXISPACE_SCOPES.includes('mailboxes'), true);
  assert.equal(HEXISPACE_SCOPES.includes('artifacts'), true);
  const manifest = publicManifest({ version: '0.0.1', origin: 'http://127.0.0.1:4318' });
  assert.equal(manifest.capabilities.includes('mailboxes'), true);
  assert.equal(manifest.capabilities.includes('artifacts'), true);
  assert.equal(manifest.artifacts.providerUrls, 'owner-consented-external-link');
  assert.equal(manifest.artifacts.sandboxFiles, 'local-scoped-download');
  assert.equal(manifest.artifacts.inlinePreviews, 'safe-text-metadata-only');
  assert.equal(manifest.supportMatrix.messages.externalHarnesses, 'not-advertised');
  assert.equal(JSON.stringify(manifest).includes('access_token'), false);
});

test('mailbox metadata is isolated to its approved connector link', () => {
  const state = { hexispace: { pairings: [], links: [], mailboxes: [{ id: 'mailbox-12345678', linkId: 'link-a', profileId: 'profile-a', provider: 'gmail', email: 'agent@example.com', scopes: ['https://mail.google.com/'], vaultRef: 'hexispace-mailbox-12345678', connectedAt: '2026-09-16', updatedAt: '2026-09-16' }] } };
  normalizeHexiSpaceConnector(state);
  assert.equal(state.hexispace.mailboxes.length, 1);
  assert.equal(state.hexispace.mailboxes[0].linkId, 'link-a');
  assert.equal(JSON.stringify(state).includes('accessToken'), false);
});

test('Hexonaut social state persists only a vault reference, never raw bearer credentials', () => {
  const state = { hexispace: { pairings: [], links: [], agentSocials: [{
    profileId: 'profile-12345678', agentId: 'agent-1', agentLinkId: 'link-1',
    vaultRef: 'hexispace-social-profile-12345678', supabaseUrl: 'https://example.supabase.co',
    anonKey: 'public-anon-key', capabilities: ['manage_friends', 'manage_relationships'],
    token: 'hss_sensitive-bearer-token', socialToken: 'hss_sensitive-social-token',
    accessToken: 'oauth-sensitive-token', secret: 'private-secret'
  }] } };

  normalizeHexiSpaceConnector(state);

  assert.deepEqual(state.hexispace.agentSocials[0], {
    linkId: '', profileId: 'profile-12345678', agentId: 'agent-1', agentLinkId: 'link-1',
    supabaseUrl: 'https://example.supabase.co', anonKey: 'public-anon-key',
    vaultRef: 'hexispace-social-profile-12345678', capabilities: ['manage_friends', 'manage_relationships'], connectedAt: ''
  });
  assert.doesNotMatch(JSON.stringify(state), /hss_sensitive|oauth-sensitive|private-secret/);
});

test('the former connector state namespace migrates without losing private links', () => {
  const state = { hexiverse: { pairings: [], links: [{ id: 'legacy-link', origin: 'http://127.0.0.1:4340', scopes: ['messages'], status: 'connected' }], mailboxes: [], conversations: [] } };
  const connector = normalizeHexiSpaceConnector(state);
  assert.equal(connector.links[0].id, 'legacy-link');
  assert.equal(state.hexispace.links[0].id, 'legacy-link');
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'hexiverse'), false);
});

test('approved pairing can grant the mailbox scope explicitly', () => {
  const state = { hexispace: { pairings: [], links: [] } };
  const pairing = createHexiSpacePairing(state, { origin: 'http://127.0.0.1:4340', scopes: ['mailboxes'] });
  const approved = approveHexiSpacePairing(state, { code: pairing.code, scopes: ['mailboxes'] });
  assert.deepEqual(approved.scopes, ['mailboxes']);
});

test('pairing origins are reduced to safe exact origins', () => {
  const state = { hexispace: { pairings: [], links: [] } };
  const httpsPairing = createHexiSpacePairing(state, { origin: 'https://hexispace.example/path', scopes: ['messages'] });
  const loopbackPairing = createHexiSpacePairing(state, { origin: 'http://[::1]:4340', scopes: ['messages'] });
  const insecurePairing = createHexiSpacePairing(state, { origin: 'http://hexispace.example', scopes: ['messages'] });
  const credentialPairing = createHexiSpacePairing(state, { origin: 'https://user:secret@hexispace.example', scopes: ['messages'] });
  assert.equal(state.hexispace.pairings.find((item) => item.id === httpsPairing.id).origin, '');
  assert.equal(state.hexispace.pairings.find((item) => item.id === loopbackPairing.id).origin, 'http://[::1]:4340');
  assert.equal(state.hexispace.pairings.find((item) => item.id === insecurePairing.id).origin, '');
  assert.equal(state.hexispace.pairings.find((item) => item.id === credentialPairing.id).origin, '');
});

test('approved pairing can grant the artifact scope explicitly', () => {
  const state = { hexispace: { pairings: [], links: [] } };
  const pairing = createHexiSpacePairing(state, { origin: 'http://127.0.0.1:4340', scopes: ['artifacts'] });
  const approved = approveHexiSpacePairing(state, { code: pairing.code, scopes: ['artifacts'] });
  assert.deepEqual(approved.scopes, ['artifacts']);
});

test('pairing drops capabilities that do not have a HexiGrid endpoint yet', () => {
  const state = { hexispace: { pairings: [], links: [] } };
  const pairing = createHexiSpacePairing(state, { origin: 'http://127.0.0.1:4340', scopes: ['messages', 'publish_posts', 'live_calls'] });
  assert.deepEqual(pairing.scopes, ['messages']);
});

test('HexiSpace receives only the linked-agent display fields, never private agent state', () => {
  const agent = {
    id: 'agent-123', name: 'Juniper', status: 'active', model: 'local-model',
    personality: 'private personality', instructions: 'private system prompt',
    memories: ['private memory'], accountLabel: 'private account',
    externalEmail: 'private@example.com', workspacePath: 'C:/private', providerKey: 'secret'
  };

  assert.deepEqual(linkedAgentSummary(agent), { id: 'agent-123', name: 'Juniper', status: 'active', model: 'local-model' });
  assert.equal(JSON.stringify(linkedAgentSummary(agent)).includes('private'), false);
  assert.equal(JSON.stringify(linkedAgentSummary(agent)).includes('secret'), false);
  assert.equal(linkedAgentSummary({ id: '', name: 'No id' }), null);
  assert.equal(linkedAgentSummary({ id: 'agent-1', name: 'Unknown status', status: 'private-memory-dump' }).status, 'unknown');
  assert.equal(linkedAgentSummary({ id: 'agent-2', name: 'Connected', status: 'connected' }).status, 'connected');
});

test('a HexiSpace bridge token can disconnect only its own grant', () => {
  const state = { hexispace: { pairings: [], links: [] } };
  const pairing = createHexiSpacePairing(state, { origin: 'https://hexispace.example', scopes: ['messages'] });
  const approved = approveHexiSpacePairing(state, { code: pairing.code, scopes: ['messages'] });
  const otherPairing = createHexiSpacePairing(state, { origin: 'https://other.example', scopes: ['messages'] });
  const otherApproved = approveHexiSpacePairing(state, { code: otherPairing.code, scopes: ['messages'] });

  assert.equal(revokeHexiSpaceLinkByToken(state, `Bearer ${approved.token}`), approved.id);
  assert.throws(() => authenticateHexiSpace(state, `Bearer ${approved.token}`), /not authorized/);
  assert.equal(authenticateHexiSpace(state, `Bearer ${otherApproved.token}`, 'messages').status, 'connected');
});

test('the owner connection list contains no bearer token or vault secret reference', () => {
  const state = { hexispace: { pairings: [], links: [{ id: 'hv-link-1', origin: 'https://hexispace.example/path', scopes: ['messages'], status: 'revoked', createdAt: '2026-09-17T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-09-17T01:00:00.000Z', tokenHash: 'must-not-leak' }], mailboxes: [{ id: 'mailbox-1', linkId: 'hv-link-1', provider: 'gmail', vaultRef: 'private-vault-reference' }] } };
  const links = hexispaceLinkSummaries(state);
  assert.deepEqual(links, [{ id: 'hv-link-1', origin: 'https://hexispace.example', scopes: ['messages'], status: 'revoked', createdAt: '2026-09-17T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-09-17T01:00:00.000Z', mailboxCleanupPending: 1 }]);
  assert.equal(JSON.stringify(links).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(links).includes('private-vault-reference'), false);
});

test('HexiSpace task listing is isolated by connector and omits prompts and agent output', () => {
  const tasks = [
    { id: 'task-a', name: '<daily check>', agentId: 'agent-a', source: 'hexispace', connectorId: 'link-a', status: 'paused', intervalSeconds: 900, maxRuns: 10, runCount: 2, prompt: 'private instructions', lastOutput: 'private response', lastError: 'private error', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T01:00:00.000Z' },
    { id: 'task-b', name: 'other link', agentId: 'agent-b', source: 'hexispace', connectorId: 'link-b', status: 'running' },
    { id: 'task-c', name: 'local task', agentId: 'agent-c', status: 'running' }
  ];
  const summaries = hexispaceTaskSummaries(tasks, 'link-a');
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], { id: 'task-a', name: '<daily check>', agentId: 'agent-a', intervalSeconds: 900, maxRuns: 10, runCount: 2, status: 'paused', nextRunAt: null, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T01:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(summaries), /private instructions|private response|private error|connectorId/);
  assert.equal(isHexiSpaceTaskOwnedByLink(tasks[0], 'link-a'), true);
  assert.equal(isHexiSpaceTaskOwnedByLink(tasks[0], 'link-b'), false);
  assert.equal(isHexiSpaceTaskOwnedByLink(tasks[2], 'link-a'), false);
});

test('HexiSpace repeating tasks have a safe minimum cadence and bounded runs', () => {
  assert.deepEqual(normalizeHexiSpaceTaskSchedule({ intervalSeconds: 1, maxRuns: 10000, maxRetries: 10 }), { intervalSeconds: 900, maxRuns: 100, maxRetries: 3 });
  assert.deepEqual(normalizeHexiSpaceTaskSchedule({ intervalSeconds: 3600, maxRuns: 8, maxRetries: 0 }), { intervalSeconds: 3600, maxRuns: 8, maxRetries: 0 });
  assert.deepEqual(normalizeHexiSpaceTaskSchedule({ intervalSeconds: 0, maxRuns: 80, maxRetries: 9 }), { intervalSeconds: 0, maxRuns: 1, maxRetries: 3 });
});

test('the owner approval page starts with every permission disabled and offers emergency stop', async () => {
  const html = await readFile(fileURLToPath(new URL('../public/hexispace-approve.html', import.meta.url)), 'utf8');
  assert.deepEqual(HEXISPACE_SCOPES, ['messages', 'scheduled_work', 'mailboxes', 'emergency_stop', 'artifacts', 'agent_profiles', 'agent_posts', 'agent_comments', 'agent_friends', 'agent_relationships', 'agent_reactions']);
  assert.doesNotMatch(html, /name="scope"[^>]*checked/);
  assert.doesNotMatch(html, /value="(read_feed|publish_posts|comment_react|manage_hexonauts|upload_media|live_calls)"/);
  assert.match(html, /value="emergency_stop"/);
  assert.match(html, /value="messages"/);
  assert.match(html, /value="agent_profiles"/);
  assert.match(html, /value="agent_posts"/);
  assert.match(html, /value="agent_comments"/);
  assert.match(html, /value="agent_friends"/);
  assert.match(html, /value="agent_relationships"/);
  assert.match(html, /value="agent_reactions"/);
  assert.match(html, /Stop HexiGrid agent activity from HexiSpace/);
  assert.match(html, /cloud model provider may process that context/);
});
