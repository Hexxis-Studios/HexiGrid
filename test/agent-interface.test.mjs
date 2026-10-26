import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

test('Codex messaging editor loads separate settings when the selected agent changes', async () => {
  const source = await readFile(new URL('../public/agent-interface.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function renderCodexRelaySettings(state)');
  const end = source.indexOf("  document.querySelector('#codexRelayLink')?.addEventListener", start);
  const fields = Object.fromEntries(['Link', 'Thread', 'Replies', 'NamedThreads', 'Enabled', 'Feedback'].map(name => [`#codexRelay${name}`, {}]));
  fields['#codexApprovedChats'] = {};
  const state = { settings: { codexRelay: { linkId: 'link-muse', threadId: 'thread-muse-123', enabled: true, allowNamedThreads: true,
    routes: [{ linkId: 'link-ilander', threadId: 'thread-ilander-123', enabled: true, forwardReplies: false }] } } };
  const render = runInNewContext(`let codexRelaySelection = ''; let codexConversationChoices = []; ${source.slice(start, end)}; (id) => { codexRelaySelection = id; renderCodexRelaySettings(state); }`, {
    state, document: { querySelector: selector => fields[selector] }, escape: String, linkLabel: link => link.id,
    connectedLinks: () => [{ id: 'link-muse', trustLevel: 'owner' }, { id: 'link-ilander', trustLevel: 'scoped' }, { id: 'link-new', trustLevel: 'scoped' }]
  });
  render('link-muse');
  assert.equal(fields['#codexRelayThread'].value, 'thread-muse-123');
  assert.equal(fields['#codexRelayNamedThreads'].checked, true);
  render('link-ilander');
  assert.equal(fields['#codexRelayThread'].value, 'thread-ilander-123');
  assert.match(fields['#codexApprovedChats'].innerHTML, /disabled title="Default conversation" checked/);
  assert.doesNotMatch(fields['#codexApprovedChats'].innerHTML, /thread-muse-123/);
  assert.equal(fields['#codexRelayReplies'].checked, false);
  assert.equal(fields['#codexRelayNamedThreads'].checked, false);
  assert.equal(fields['#codexRelayNamedThreads'].disabled, true);
  render('link-new');
  assert.equal(fields['#codexRelayThread'].value, '');
  assert.equal(fields['#codexRelayEnabled'].checked, false);
  render('link-muse');
  assert.equal(fields['#codexRelayThread'].value, 'thread-muse-123');
});

test('UIA catalog documents the existing signed desktop methods without owner-session substitution', () => {
  const { actions } = agentInterfaceManifest();
  assert.equal(actions.signedLinkUiaInspect.path, '/agent-link/v1/desktop/uia-inspect');
  assert.deepEqual(actions.signedLinkUiaInspect.capabilities, ['desktop-view']);
  assert.deepEqual(actions.signedLinkUiaAct.capabilities, ['desktop-view', 'desktop-control']);
  assert.equal(actions.signedLinkUiaAct.operations['set-value'].extraCapability, 'desktop-type');
  assert.match(actions.signedLinkUiaAct.note, /mayHaveApplied/);
  assert.match(actions.signedLinkUiaInspect.note, /Signed Link/);
});

test('typed mistake reads are discoverable only on the signed Link with bounded depth and read grant', () => {
  const { actions } = agentInterfaceManifest();
  for (const name of ['list-memory-mistakes', 'get-memory-mistake']) {
    assert.ok(actions.signedLinkPrivateMemoryMcp.tools.includes(name));
    assert.ok(!actions.privateMemoryMcp.tools.includes(name));
    assert.deepEqual(actions.signedLinkPrivateMemoryMcp.capabilitiesByTool[name], ['memory-read']);
  }
  assert.deepEqual(actions.signedLinkPrivateMemoryMcp.mistakeReads.requiredScope, ['projectId']);
  assert.equal(actions.signedLinkPrivateMemoryMcp.mistakeReads.maximumMaxBytes, 32768);
});

test('existing dated checkpoints and whole-app recovery are discoverable with their owner boundaries', () => {
  const { actions } = agentInterfaceManifest();
  const expected = {
    listMemoryCheckpoints: ['GET', '/api/agents/{agentId}/memory-rollback-checkpoints'],
    saveMemoryCheckpoint: ['POST', '/api/agents/{agentId}/memory-rollback-checkpoints'],
    restoreMemoryCheckpoint: ['POST', '/api/agents/{agentId}/memory-rollback-checkpoints/{checkpointId}/restore'],
    deleteMemoryCheckpoint: ['DELETE', '/api/agents/{agentId}/memory-rollback-checkpoints/{checkpointId}'],
    exportEncryptedBackup: ['POST', '/api/backup/export'], restoreEncryptedBackup: ['POST', '/api/backup/import'],
    undoBackupRestore: ['POST', '/api/backup/rollback']
  };
  for (const [name, [method, route]] of Object.entries(expected)) {
    assert.equal(actions[name].method, method);
    assert.equal(actions[name].path || actions[name].pathTemplate, route);
    assert.equal(actions[name].ownerOnly, true);
  }
  assert.deepEqual(actions.restoreMemoryCheckpoint.required, ['approved', 'expectedCurrent', 'why']);
  assert.match(actions.restoreMemoryCheckpoint.note, /Stale heads return409/);
  assert.match(actions.restoreMemoryCheckpoint.note, /not owner notes, skills, grants or app settings/);
  assert.deepEqual(actions.restoreEncryptedBackup.required, ['envelope', 'passphrase', 'confirmReplace']);
  for (const name of ['exportEncryptedBackup', 'restoreEncryptedBackup', 'undoBackupRestore']) assert.equal(actions[name].hostOnly, true);
  assert.match(actions.restoreEncryptedBackup.note, /Links stay revoked/);
});

test('agent interface manifest is versioned, predictable, and has no permission bypass', () => {
  const manifest = agentInterfaceManifest({ version: '0.0.1' });
  assert.equal(manifest.schemaVersion, '1.0');
  assert.equal(manifest.presentation.agent, '/agent-interface.html');
  assert.equal(manifest.security.authenticationRequired, true);
  assert.equal(manifest.security.permissionBypassAvailable, false);
  assert.equal(manifest.resources.avatarPresence.pathTemplate, '/api/agents/{agentId}/avatar-presence');
  assert.equal(manifest.actions.updateAvatarPresence.method, 'PATCH');
  assert.deepEqual(manifest.actions.updateAvatarPresence.required, ['expectedRevision']);
  assert.equal(manifest.actions.signedLinkAvatar.path, manifest.avatarPresentation.read.path);
  assert.equal(manifest.actions.signedLinkAvatar.capability, 'messages');
  assert.match(manifest.actions.signedLinkAvatar.note, /own paired agent only/);
  assert.match(manifest.actions.signedLinkAvatar.note, /stale edits return 409/);
  assert.equal(manifest.actions.sendRoomMessage.method, 'POST');
  assert.equal(manifest.actions.runHarnessJob.path, '/api/harness-jobs');
  assert.ok(manifest.actions.runHarnessJob.optional.includes('clientJobId'));
  assert.match(manifest.actions.runHarnessJob.note, /encrypted locally/);
  assert.match(manifest.actions.getHarnessJob.description, /interrupted without automatic replay/);
  assert.equal(manifest.actions.cancelHarnessJob.path, '/api/harness-jobs/{jobId}/cancel');
  assert.equal(manifest.actions.previewLink.path, '/api/link-preview');
  assert.equal(manifest.actions.saveContinuityDraft.pathTemplate, '/api/agents/{agentId}/continuity-draft');
  assert.equal(manifest.actions.requestContinuityExport.pathTemplate, '/api/agents/{agentId}/continuity-export-request');
  assert.match(manifest.actions.previewLink.note, /never proxied or executed/i);
  assert.match(JSON.stringify(manifest), /Never request, display, log/);
  assert.doesNotMatch(JSON.stringify(manifest), /apiKey|passwordHash|recoveryHash|cookieValue/);
});

test('plugin and MCP contracts distinguish owner authentication, discovery and execution', () => {
  const { actions, resources } = agentInterfaceManifest();
  assert.equal(resources.plugins.responseField, 'plugins');
  assert.equal(resources.mcpServers.path, '/api/mcp');
  for (const name of ['runPlugin', 'setPluginEnabled', 'discoverMcpTools', 'setMcpEnabled', 'callMcpTool']) assert.equal(actions[name].ownerOnly, true);
  assert.deepEqual(actions.runPlugin.required, ['capability']);
  assert.match(actions.runPlugin.note, /no fallback execution/);
  assert.match(actions.discoverMcpTools.note, /not approval/);
  assert.match(actions.setMcpEnabled.note, /every tool reviewed/);
  assert.match(actions.callMcpTool.note, /drift disables/);
  assert.equal(actions.linkedPluginCatalog.authentication, 'signed Link');
  assert.equal(actions.linkedPluginCatalog.capability, 'owner-filesystem-read');
  assert.equal(actions.runLinkedPlugin.capability, 'owner-process');
  assert.match(actions.runLinkedPlugin.note, /approved:true is ignored/);
  assert.equal(actions.linkedMcpCatalog.capability, 'owner-filesystem-read');
  assert.equal(actions.callLinkedMcpTool.authentication, 'signed Link');
  assert.match(actions.callLinkedMcpTool.note, /before tool dispatch/);
  assert.match(actions.runTask.note, /paused repeating task stays paused/);
});

test('owner plugin install, credential, removal and publisher contracts match local routes', () => {
  const { actions, resources } = agentInterfaceManifest();
  assert.equal(resources.plugins.path, '/api/bootstrap');
  assert.equal(resources.pluginPublishers.method, 'GET');
  assert.equal(resources.pluginPublishers.path, '/api/bootstrap');
  assert.equal(resources.pluginPublishers.ownerOnly, true);
  assert.equal(resources.pluginPublishers.responseField, 'pluginPublishers');
  assert.match(resources.pluginPublishers.description, /fingerprints.*trusted\/revoked/);
  assert.match(resources.pluginPublishers.description, /No publisher private keys or credential values/);

  const install = actions.installPlugin;
  assert.equal(install.method, 'POST');
  assert.equal(install.path, '/api/plugins/install');
  assert.equal(install.ownerOnly, true);
  assert.equal(install.hostOnly, true);
  assert.deepEqual(install.required, ['manifest', 'files']);
  assert.deepEqual(install.optional, ['localOwnerApproved', 'trustPublisher', 'approved']);
  assert.equal(install.policyCapability, 'write_workspace');
  assert.equal(install.risk, 'high');
  assert.equal(install.successStatus, 201);
  assert.equal(install.response, '{plugin,receipt}');
  assert.deepEqual(install.fileEntry.required, ['path', 'content']);
  assert.equal(install.maxBodyBytes, 14 * 1024 * 1024);
  assert.match(install.note, /enabled:false/);
  assert.match(install.note, /never executes plugin code/);
  assert.match(install.note, /approved:true is the authenticated owner's confirmation when policy asks/);
  assert.match(install.note, /cannot override Plan or a deny decision/);
  assert.match(install.recovery, /replacement disables the previous record/);

  const credentials = actions.setPluginCredentials;
  assert.equal(credentials.method, 'PUT');
  assert.equal(credentials.path, '/api/plugins/{pluginId}/secrets');
  assert.equal(credentials.ownerOnly, true);
  assert.equal(credentials.hostOnly, true);
  assert.deepEqual(credentials.required, ['secrets']);
  assert.equal(credentials.policyCapability, 'run_tools');
  assert.equal(credentials.risk, 'high');
  assert.equal(credentials.successStatus, 200);
  assert.equal(credentials.response, '{plugin,receipt}');
  assert.match(credentials.note, /empty string clears that ID/);
  assert.match(credentials.note, /stored only in the OS credential vault/);
  assert.match(credentials.note, /owner-authorized secure source/);
  assert.match(credentials.note, /never request or place them in chat, prompts or logs/);
  assert.match(credentials.note, /approved:true is the authenticated owner's confirmation when policy asks/);
  assert.match(credentials.recovery, /earlier entries may already be saved/);

  const remove = actions.removePlugin;
  assert.equal(remove.method, 'DELETE');
  assert.equal(remove.path, '/api/plugins/{pluginId}');
  assert.equal(remove.ownerOnly, true);
  assert.equal(remove.hostOnly, undefined);
  assert.equal(remove.policyCapability, 'write_workspace');
  assert.equal(remove.risk, 'high');
  assert.equal(remove.successStatus, 200);
  assert.equal(remove.response, '{ok,receipt}');
  assert.match(remove.note, /approved:true is the authenticated owner's confirmation when policy asks/);
  assert.match(remove.recovery, /removalPending/);
  assert.match(remove.recovery, /retry this DELETE/);

  const revoke = actions.revokePluginPublisher;
  assert.equal(revoke.method, 'DELETE');
  assert.equal(revoke.path, '/api/plugin-publishers/{publisherId}');
  assert.equal(revoke.ownerOnly, true);
  assert.equal(revoke.hostOnly, true);
  assert.equal(revoke.policyCapability, 'run_tools');
  assert.equal(revoke.risk, 'high');
  assert.equal(revoke.successStatus, 200);
  assert.equal(revoke.response, '{ok,publisher,receipt}');
  assert.match(revoke.note, /approved:true is the authenticated owner's confirmation when policy asks/);
  assert.match(revoke.recovery, /cleanupPending/);
  assert.match(revoke.recovery, /retry this DELETE/);
  assert.match(revoke.note, /never key or credential values/);
});

test('agent interface advertises private memory tools, owner commits, and signed Link grants', () => {
  const actions = agentInterfaceManifest().actions;
  const tools = ['inspect-memory-health', 'append-log', 'propose-memory', 'propose-correction', 'propose-owner-memory-correction', 'read-log-range',
    'get-memory', 'recall-context', 'list-context-scopes', 'semantic-search', 'recall-entity'];
  assert.deepEqual(actions.privateMemoryMcp.tools, tools);
  assert.equal(actions.privateMemoryMcp.pathTemplate, '/api/agents/{agentId}/memory-mcp');
  assert.deepEqual(actions.privateMemoryMcp.contextScope.required, ['projectId']);
  assert.deepEqual(actions.privateMemoryMcp.contextScope.optional, ['topicId']);

  const linked = actions.signedLinkPrivateMemoryMcp;
  assert.equal(linked.path, '/agent-link/v1/memory-mcp');
  const signedTools = ['inspect-memory-health', 'list-memory-pressure', 'append-log', 'propose-memory', 'propose-correction',
    'propose-owner-memory-correction', 'list-owner-note-capture-retries', 'read-log-range', 'get-memory',
    'list-memory-mistakes', 'get-memory-mistake', 'list-owner-notes', 'get-owner-note', 'get-owner-note-history',
    'restore-owner-note', 'retire-owner-note', 'recall-context', 'list-context-scopes', 'semantic-search',
    'recall-entity', 'record-retrieval-feedback'];
  assert.deepEqual(linked.tools, signedTools);
  assert.deepEqual(Object.keys(linked.capabilitiesByTool), signedTools);
  assert.deepEqual(linked.capabilitiesByTool['propose-memory'], ['memory-write']);
  assert.deepEqual(linked.capabilitiesByTool['propose-correction'], ['memory-read', 'memory-write']);
  assert.deepEqual(linked.capabilitiesByTool['propose-owner-memory-correction'], ['memory-read', 'memory-write']);
  assert.deepEqual(linked.capabilitiesByTool['list-owner-note-capture-retries'], ['memory-read']);
  assert.deepEqual(linked.capabilitiesByTool['list-memory-pressure'], ['memory-read']);
  assert.deepEqual(linked.capabilitiesByTool['retire-owner-note'], ['memory-read', 'memory-write']);
  assert.equal(linked.ownerNoteRetirement.requiredTrustLevel, 'owner');
  assert.equal(linked.ownerNoteRetirement.risk, 'medium');
  assert.deepEqual(linked.capabilitiesByTool['record-retrieval-feedback'], ['memory-read', 'memory-write']);
  assert.equal(actions.signedLinkOwnerMachine.pathPrefix, '/agent-link/v1/owner/');
  assert.equal(actions.signedLinkOwnerMachine.operations.exec.capability, 'owner-process');
  assert.equal(actions.signedLinkCapabilityToggle.path, '/agent-link/v1/capabilities');
  assert.match(actions.signedLinkCapabilityToggle.note, /subset of capabilities already granted/);
  for (const name of ['read-log-range', 'get-memory', 'list-owner-notes', 'get-owner-note', 'recall-context', 'list-context-scopes', 'semantic-search', 'recall-entity', 'list-memory-pressure']) {
    assert.deepEqual(linked.capabilitiesByTool[name], ['memory-read']);
  }
  assert.match(linked.note, /signed, paired Link/);
  assert.match(linked.note, /contextScope/);
  assert.equal(actions.signedLinkMemoryScope.path, '/agent-link/v1/memory-scope');
  assert.deepEqual(actions.signedLinkMemoryScope.optional, ['codexThreadId']);
  assert.equal(actions.signedLinkMemoryScope.capability, 'memory-read');
  assert.match(actions.signedLinkMemoryScope.note, /bounded memoryContext/);
  assert.match(actions.signedLinkMemoryScope.note, /never falls back to the global selection/);

  const commit = actions.commitPrivateMemory;
  assert.equal(commit.ownerOnly, true);
  assert.deepEqual(Object.keys(commit.operations), ['create', 'revise', 'correct', 'evaluate', 'confirm', 'conflict']);
  assert.equal(commit.operations.confirm.required.includes('approved'), true);
  assert.deepEqual(commit.contextScope.required, ['projectId']);
  assert.deepEqual(commit.contextScope.optional, ['topicId']);
  assert.ok(commit.operations.create.optional.includes('contextScope'));
  assert.ok(commit.operations.create.optional.includes('valid_from'));
  assert.ok(commit.operations.create.optional.includes('valid_until'));
  assert.ok(commit.operations.revise.changes.includes('contextScope'));
  assert.ok(commit.operations.revise.changes.includes('valid_from'));
  assert.ok(commit.operations.revise.changes.includes('valid_until'));
  assert.deepEqual(commit.operations.correct.changesRequired, ['text']);
  assert.ok(commit.operations.correct.changesOptional.includes('valid_from'));
  assert.ok(commit.operations.correct.changesOptional.includes('valid_until'));
  assert.ok(commit.operations.correct.required.includes('source'));
  assert.ok(commit.operations.correct.required.includes('expectedNextBehavior'));
  assert.deepEqual(commit.operations.evaluate.outcomes, ['pass', 'fail', 'unknown']);
  assert.ok(commit.operations.evaluate.required.includes('correctionRevisionId'));
  assert.ok(commit.operations.evaluate.required.includes('observed'));
  assert.deepEqual(commit.observation.kinds, ['owner-feedback', 'agent-link-message']);

  assert.deepEqual(commit.validTime.fields, ['valid_from', 'valid_until']);
  assert.match(commit.validTime.format, /canonical UTC timestamp/);
  assert.match(commit.validTime.interval, /inclusive start, exclusive end/);
  assert.match(commit.validTime.omittedStart, /unknown/);
  assert.match(commit.validTime.omittedStart, /createdAt or recorded time is not substituted/);
  assert.match(commit.validTime.omittedEnd, /no ending boundary was asserted/);
  assert.ok(commit.operations.conflict.optional.includes('valid_from'));
  assert.equal(commit.operations.conflict.validFromBoundary.format, commit.validTime.format);
  assert.equal(commit.operations.conflict.validFromBoundary.mustMatchIfSuccessorDeclaresStart, true);
  assert.match(commit.operations.conflict.validFromBoundary.effect, /valid_until/);
  assert.match(commit.operations.conflict.note, /not automatic conflict resolution/);
  assert.match(commit.operations.conflict.note, /recorded time is never used as a factual boundary/);
});

test('conversation learning preferences support local and paired profiles without enabling Runner learning', async () => {
  const source = await readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8');
  const elements = {
    '#transport': { value: 'local-opencode' },
    '#agentLearnFromConversations': { checked: true, disabled: false, dataset: {} },
    '#agentLearnFromConversationsHelp': { textContent: '' },
    '#agentLearningModelField': { hidden: false },
    '#agentLearningModel': { disabled: false },
    '#agentLearningModelHelp': { textContent: '' }
  };
  let changeHandler;
  const state = { editingAgentId: 'local-agent' };
  const context = {
    document: { addEventListener: (type, handler) => { if (type === 'change') changeHandler = handler; } },
    $: (selector) => elements[selector],
    state
  };
  runInNewContext(source, context);
  const learning = elements['#agentLearnFromConversations'];
  assert.equal(context.agentLearningPreference({ transport: 'local-opencode' }), true);
  assert.equal(context.agentLearningPreference({ transport: 'ilands-runner' }), false);
  assert.equal(context.agentLearningPreference({ transport: 'local-opencode', learnFromConversations: false }), false);
  assert.deepEqual({ ...context.agentLearningPatch('ilands-runner', true) }, {}, 'saving an external profile leaves any explicitly stored preference untouched');
  assert.deepEqual({ ...context.agentLearningPatch('local-opencode', true) }, { learnFromConversations: true });
  assert.deepEqual({ ...context.agentLearningPatch('local-opencode', false) }, { learnFromConversations: false });
  assert.deepEqual({ ...context.agentLearningPatch('ilands-link', true) }, { learnFromConversations: true });
  assert.deepEqual({ ...context.agentLearningPatch('agent-link', false) }, { learnFromConversations: false });

  learning.dataset.localProfile = 'true';
  learning.dataset.localChoice = 'true';
  learning.dataset.userChanged = 'false';
  elements['#transport'].value = 'ilands-runner';
  context.syncAgentLearningControl();
  assert.equal(learning.disabled, true);
  assert.equal(learning.checked, false);
  elements['#transport'].value = 'local-opencode';
  context.syncAgentLearningControl();
  assert.equal(learning.disabled, false);
  assert.equal(learning.checked, true);

  learning.checked = false;
  changeHandler({ target: learning });
  elements['#transport'].value = 'ilands-runner';
  context.syncAgentLearningControl();
  elements['#transport'].value = 'local-opencode';
  context.syncAgentLearningControl();
  assert.equal(learning.checked, false, 'a saved local opt-out survives disabling and re-enabling the local profile');

  state.editingAgentId = null;
  learning.dataset.userChanged = 'false';
  learning.dataset.localProfile = 'false';
  learning.dataset.localChoice = 'false';
  elements['#transport'].value = 'local-opencode';
  context.syncAgentLearningControl();
  assert.equal(learning.checked, true, 'a new local profile defaults on');
  assert.equal(learning.disabled, false);
});

test('owner turn-context read and profile response-memory preference match local routes', () => {
  const { actions } = agentInterfaceManifest();
  const read = actions.readAgentMemoryTurnContext;
  assert.equal(read.method, 'POST');
  assert.equal(read.pathTemplate, '/api/agents/{agentId}/memory-turn-context');
  assert.equal(read.ownerOnly, true);
  assert.equal(read.csrfRequired, true);
  assert.equal(read.policyCapability, 'read_local');
  assert.equal(read.risk, 'low');
  assert.deepEqual(read.optional, ['latestMessage', 'currentTask', 'includeDisputed', 'asOf', 'validAt']);
  assert.deepEqual(read.inputLimits, { latestMessage: 4096, currentTask: 2048, asOf: 24, validAt: 24 });
  assert.deepEqual(read.inputTypes, { includeDisputed: 'boolean', asOf: 'string', validAt: 'string' });
  assert.equal(read.inputFormats.asOf, 'YYYY-MM-DDTHH:mm:ss.sssZ; canonical UTC timestamp');
  assert.equal(read.inputFormats.validAt, read.inputFormats.asOf);
  assert.equal(read.maxBodyBytes, 8 * 1024);
  assert.equal(read.response, '{memoryContext:{status,text,identityCount,factCount,omittedCount,reason?}}');
  assert.deepEqual(read.statuses, ['ready', 'empty', 'disabled', 'unavailable']);
  assert.match(read.note, /exact active continuity lineage/);
  assert.match(read.note, /caller cannot choose a lineage or scope/);
  assert.match(read.note, /single scope in the requested current, recorded, or valid-time view/);
  assert.match(read.note, /includeDisputed:true explicitly includes disputed facts/);
  assert.match(read.note, /asOf selects an append-only recorded-revision snapshot/);
  assert.match(read.note, /validAt independently selects when facts applied/);
  assert.match(read.note, /first reconstructs what was recorded by asOf, then filters explicit validity windows at validAt/);
  assert.match(read.note, /rejected memories are always excluded/);
  assert.match(read.note, /without an asserted valid_from instead of inferring one from createdAt/);
  assert.match(read.note, /creates no receipt or retrieval metric/);
  assert.match(read.recovery, /continue without dated memory/);
  assert.match(read.recovery, /ambiguous scope/);

  const create = actions.createAgent;
  const update = actions.updateAgent;
  assert.ok(create.optional.includes('useMemories'));
  assert.ok(create.optional.includes('transport'));
  assert.ok(create.optional.includes('learnFromConversations'));
  assert.match(create.note, /transport accepts local-opencode or ilands-runner and defaults to local-opencode/);
  assert.match(create.note, /Use a HexiGrid Link invitation to pair an existing external agent/);
  assert.match(create.note, /Unsupported transports return an error/);
  assert.match(create.note, /defaults to true only for local-opencode profiles and false for other transports/);
  assert.match(create.note, /completed conversations retained in HexiGrid/);
  assert.ok(create.optional.includes('memoryLearningModel'));
  assert.match(create.note, /keyless localhost model/);
  assert.match(create.note, /no private chats are imported from Muse/);
  assert.equal(update.method, 'PATCH');
  assert.equal(update.path, '/api/agents/{agentId}');
  assert.ok(update.optional.includes('useMemories'));
  assert.ok(update.optional.includes('transport'));
  assert.ok(update.optional.includes('memoryLearningModel'));
  assert.ok(update.optional.includes('learnFromConversations'));
  assert.match(update.note, /connected Agent Link profile can retain ilands-link but cannot switch to another source/);
  assert.match(update.note, /false suppresses owner-note and dated-memory context/);
  assert.match(update.note, /learnFromConversations is an independent boolean/);
  assert.match(update.note, /false stops new local extraction and preserves saved memories/);
  assert.match(update.note, /Omit it to keep the current preference/);
  assert.match(update.note, /defaults to true only for local-opencode and false for other transports/);
  assert.match(update.note, /completed signed room turns and successful retained signed task runs/);
  assert.match(update.note, /exact Link is connected and authorized for its selected project\/topic scope/);
  assert.match(update.note, /Tasks grant and current task policy/);
  assert.match(update.note, /explicitly selected keyless localhost memoryLearningModel/);
  assert.match(update.note, /immutable completed task definition; local v1 task learning is unchanged/);
  assert.match(update.note, /public task-run API omits internal learning authority\/source metadata/);
  assert.match(update.note, /backups retain historical definition and scope but remove the Link credential verifier/);
  assert.match(update.note, /restored signed runs cannot reuse their original authorization/);
  assert.match(update.note, /private chats in Muse or another provider app are never imported/);
});

test('memory learning resume is discoverable as an authenticated local-owner action with safe bootstrap status', () => {
  const { actions, resources } = agentInterfaceManifest();
  const resume = actions.resumeMemoryLearning;
  assert.equal(resume.method, 'POST');
  assert.equal(resume.path, '/api/memory-learning/resume');
  assert.equal(resume.ownerOnly, true);
  assert.equal(resume.hostOnly, true);
  assert.equal(resume.csrfRequired, true);
  assert.deepEqual(resume.body, {});
  assert.deepEqual(resume.policyChecks, [
    { capability: 'read_local', risk: 'low' },
    { capability: 'write_workspace', risk: 'medium' }
  ]);
  assert.match(resume.note, /authenticated owner session on the host computer/);
  assert.match(resume.note, /cannot override Plan or a deny decision/);
  assert.match(resume.note, /does not enable learning for every provider/);
  assert.match(resume.note, /does not establish that any claim is true/);

  assert.equal(resources.memoryLearningStatus.method, 'GET');
  assert.equal(resources.memoryLearningStatus.path, '/api/bootstrap');
  assert.equal(resources.memoryLearningStatus.responseField, 'memoryLearning');
  assert.match(resources.memoryLearningStatus.response, /paused:boolean.*workerStarted:boolean/);
  assert.match(resources.memoryLearningStatus.description, /does not mean every agent\/provider has an eligible source/);
});

test('owner fact browsing advertises full-result filters and a separate disputed queue', () => {
  const resource = agentInterfaceManifest().resources.agentMemoryFacts;
  assert.equal(resource.ownerOnly, true);
  assert.equal(resource.capability, 'read_local');
  assert.ok(resource.optionalQuery.includes('category'));
  assert.ok(resource.optionalQuery.includes('kind'));
  assert.match(resource.kindFormat, /historical and rejected/);
  assert.ok(resource.optionalQuery.includes('scope'));
  assert.match(resource.scopeFormat, /__unscoped__/);
  assert.match(resource.description, /before pagination/);
  assert.match(resource.description, /separate from pending proposals/);
});

test('agent interface advertises exact owner-granted cross-agent memory sharing', () => {
  const { resources, actions } = agentInterfaceManifest();
  assert.equal(resources.memoryShares.method, 'GET');
  assert.equal(resources.memoryShares.path, '/api/memory-shares');
  assert.equal(resources.memoryShares.ownerOnly, true);

  const shared = actions.signedLinkSharedMemory;
  assert.equal(shared.method, 'POST');
  assert.equal(shared.path, '/agent-link/v1/shared-memory');
  assert.equal(shared.capability, 'memory-read');
  assert.deepEqual(shared.required, ['operation']);
  assert.deepEqual(shared.operations.list.optional, ['after', 'limit']);
  assert.equal(shared.operations.list.maxLimit, 10);
  assert.deepEqual(shared.operations.recall.required, ['shareId']);
  assert.deepEqual(shared.operations.recall.optional, ['cursor', 'maxBytes']);
  assert.match(shared.note, /exact signed Link/);
  assert.match(shared.note, /Revocation ends access immediately/);

  const grant = actions.grantMemoryShare;
  assert.equal(grant.method, 'POST');
  assert.equal(grant.path, '/api/memory-shares');
  assert.equal(grant.ownerOnly, true);
  assert.deepEqual(grant.required, ['sourceAgentId', 'targetLinkId', 'scope', 'approved']);
  assert.deepEqual(grant.scope.required, ['projectId']);
  assert.deepEqual(grant.scope.optional, ['topicId']);
  assert.equal(actions.revokeMemoryShare.method, 'POST');
  assert.equal(actions.revokeMemoryShare.pathTemplate, '/api/memory-shares/{shareId}/revoke');
  assert.equal(actions.revokeMemoryShare.ownerOnly, true);
  assert.deepEqual(actions.revokeMemoryShare.required, ['approved']);
});

test('agent interface keeps skills lineage-scoped and documents owner-trusted writes', () => {
  const { resources, actions } = agentInterfaceManifest();
  assert.equal(resources.agentSkills.pathTemplate, '/api/agents/{agentId}/skills');
  assert.equal(resources.agentSkills.ownerOnly, true);
  assert.equal(resources.agentSkills.maxLimit, 20);
  assert.equal(resources.agentSkill.pathTemplate, '/api/agents/{agentId}/skills/{skillId}');
  assert.deepEqual(resources.agentSkill.depth, [0, 1]);
  assert.deepEqual(resources.agentSkill.optionalQuery, ['depth', 'beforeRevision', 'limit']);

  const linked = actions.signedLinkSkills;
  assert.equal(linked.method, 'POST');
  assert.equal(linked.path, '/agent-link/v1/skills');
  assert.equal(linked.capability, 'memory-read');
  assert.equal(linked.policyCapability, 'read_local');
  assert.deepEqual(linked.operations.list.optional, ['after', 'limit']);
  assert.equal(linked.operations.list.maxLimit, 20);
  assert.deepEqual(linked.operations.get.required, ['skillId']);
  assert.deepEqual(linked.operations.get.depth, [0, 1]);
  assert.equal(linked.operations.get.revisionCursorRequiresDepth, 1);
  assert.match(linked.note, /paired agent's active continuity lineage/);
  assert.match(linked.note, /Scoped Links cannot write/);
  for (const operation of ['create', 'revise', 'retire']) {
    assert.equal(linked.operations[operation].trustLevel, 'owner');
    assert.deepEqual(linked.operations[operation].capabilities, ['memory-read', 'memory-write']);
    assert.equal(linked.operations[operation].policyCapability, 'self_modify');
  }

  const create = actions.createAgentSkill;
  assert.equal(create.pathTemplate, '/api/agents/{agentId}/skills');
  assert.deepEqual(create.required, ['name', 'whenToUse', 'procedure', 'successCheck', 'why', 'approved']);
  const revise = actions.reviseAgentSkill;
  assert.equal(revise.pathTemplate, '/api/agents/{agentId}/skills/{skillId}/revise');
  assert.deepEqual(revise.required, ['changes', 'expectedRevision', 'why', 'approved']);
  assert.deepEqual(revise.statuses, ['active', 'retired']);
  for (const action of [create, revise]) {
    assert.equal(action.ownerOnly, true);
    assert.equal(action.capability, 'self_modify');
    assert.equal(action.risk, 'high');
  }
});

test('human and agent interfaces link to each other and agent assets are served and cached', async () => {
  const [human, agent, staticAssets, worker] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/agent-interface.html', import.meta.url), 'utf8'),
    readFile(new URL('../lib/static-assets.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
  ]);
  assert.match(human, /href="\/agent-interface\.html"/);
  assert.match(human, /id="agentUseMemories" type="checkbox" checked/);
  assert.match(human, /id="agentLearnFromConversations" type="checkbox" disabled/);
  assert.match(human, /id="agentLearnFromConversationsHelp"/);
  assert.match(human, /Use memories in responses/);
  assert.match(human, /small, bounded context locally/);
  assert.match(human, /external provider’s app are controlled there/);
  assert.match(human, /Learn from conversations/);
  assert.match(agent, /href="\/"[^>]*>Human interface/);
  assert.match(agent, /href="\/api\/agent-interface"/);
  assert.match(agent, /id="agentUnlockForm"/);
  assert.match(agent, /id="agentInterface" aria-busy="true"/);
  assert.match(agent, /id="agentStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(agent, /id="agentUnlock"[^>]*aria-labelledby="agentUnlockTitle"/);
  assert.match(agent, /id="agentUnlockTitle"/);
  assert.match(agent, /id="agentGoogleSignIn"/);
  assert.match(agent, /vendor\/firebase-google\.js/);
  assert.match(agent, /id="codexRelayForm"/);
  assert.match(agent, /id="codexRelayThread"/);
  assert.match(agent, /for="agentPasscode"/);
  assert.match(agent, /id="agentUnlockFeedback"[^>]*aria-live="polite"/);
  assert.match(agent, /Continue with the Google account linked to this workspace/);
  const [source, screenCapture, sharedRenderers, agentUi] = await Promise.all([
    readFile(new URL('../public/agent-interface.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/desktop-screen-capture.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8')
  ]);
  assert.match(agentUi, /\$\('#agentUseMemories'\)\.checked = item\?\.useMemories !== false/);
  assert.match(agentUi, /useMemories: \$\("#agentUseMemories"\)\.checked/);
  assert.match(agentUi, /function agentLearningPreference\(item\)/);
  assert.match(agentUi, /control\.disabled = !localProfile/);
  assert.match(agentUi, /Object\.assign\(payload, agentLearningPatch\(\$\("#transport"\)\.value, \$\("#agentLearnFromConversations"\)\.checked\)\)/);
  assert.match(source, /setAttribute\('aria-busy', String\(busy\)\)/);
  assert.match(source, /const form = event\.currentTarget/);
  assert.match(source, /form\.removeAttribute\('aria-busy'\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => passcodeInput\?\.focus\(\)\)/);
  assert.match(source, /if \(auth\.authenticated === false\) revealUnlockPanel\(auth\)/);
  assert.match(source, /x-hexigrid-csrf/);
  assert.match(source, /request\('\/api\/auth\/status'\)/);
  assert.match(source, /HexiGridGoogle\.prepare\(\)/);
  assert.match(source, /HexiGridGoogle\.idToken\(\)/);
  assert.match(source, /request\('\/api\/auth\/google\/firebase'/);
  assert.match(source, /HexiGridViewRenderers\.linkPresence\(link\)\.label/);
  assert.match(source, /paired \$\{when\} · \$\{shortId\}/);
  assert.match(source, /desktopBridgeSelectionTouched/);
  assert.match(source, /desktopBridgeSelectionTouched = true;\s+if \(latestManifest && latestState\) render\(latestManifest, latestState\);/);
  assert.match(source, /Choose the exact connected Hexonaut link/);
  assert.match(source, /\['memory-read', 'Read this agent’s HexiGrid memory'\]/);
  assert.match(source, /\['memory-write', 'Manage this agent’s memory under this Link’s trust and policy'\]/);
  assert.match(sharedRenderers, /action\.path \|\| action\.pathTemplate/);
  assert.match(agent, /Cross-agent memory still needs a separate owner-approved share/);
  assert.match(agent, /id="memoryReviewList"/);
  assert.match(agent, /Ordinary proposals can be saved as unverified memory/);
  assert.match(agent, /Quarantined candidates stay excluded and cannot be approved/);
  assert.match(agent, /id="skillQuarantineReview"/);
  assert.match(agent, /id="skillQuarantineStatus"/);
  assert.match(agent, /id="skillQuarantineList"/);
  assert.match(sharedRenderers, /short-term change limit/);
  assert.match(sharedRenderers, /request\('\/api\/memory-proposals'\)/);
  assert.match(sharedRenderers, /data-memory-decision="approve"/);
  assert.match(sharedRenderers, /data-memory-decision="reject"/);
  assert.match(source, /desktopBridgeMicrophoneDevice/);
  assert.match(source, /switchMicrophone/);
  assert.match(source, /desktopBridgeMicrophoneLevel/);
  assert.match(agent, /desktop-screen-capture\.js/);
  assert.match(source, /HexiGridDesktopScreen/);
  assert.ok(source.indexOf("request('/api/desktop-bridge/start'") < source.indexOf('HexiGridDesktopScreen.start'), 'the bridge must be active before browser frames are uploaded');
  assert.match(source, /owner browser screen/);
  assert.match(source, /desktopBridgeSpeaker/);
  assert.match(source, /speakerGranted/);
  assert.match(screenCapture, /browser-frame/);
  for (const asset of ['/agent-interface.html', '/agent-interface.js', '/agent-interface.css', '/desktop-screen-capture.js']) {
    assert.match(`${staticAssets}\n${worker}`, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('local snapshot contract requires host owner policy and exposes no secret or backup bytes', () => {
  const action = agentInterfaceManifest().actions.saveLocalSnapshot;
  assert.equal(action.path, '/api/backup/snapshot'); assert.equal(action.ownerOnly, true);
  assert.equal(action.capability, 'write_workspace'); assert.equal(action.risk, 'medium');
  assert.equal(action.response, '{schedule}'); assert.match(action.note, /signed Links do not gain access/);
});

test('signed MCP review pins catalog digest and keeps owner policy/session requirements visible', () => {
  const action = agentInterfaceManifest().actions.enableLinkedMcpServer;
  assert.equal(action.path, '/agent-link/v1/mcp/{serverId}/enable'); assert.equal(action.signedLink, true);
  assert.equal(action.capability, 'owner-process'); assert.ok(action.optional.includes('expectedToolSetDigest'));
  assert.match(action.note, /never bypasses Ask/); assert.match(action.note, /Shared server settings/);
});

test('signed MCP discovery describes state changes, pinned review and private-data exclusions', () => {
  const action = agentInterfaceManifest().actions.discoverLinkedMcpTools;
  assert.equal(action.path, '/agent-link/v1/mcp/{serverId}/test'); assert.equal(action.signedLink, true);
  assert.equal(action.capability, 'owner-process'); assert.match(action.note, /disables server/);
  assert.match(action.note, /no secrets\/private URL/); assert.match(action.note, /never bypasses Ask/);
});
