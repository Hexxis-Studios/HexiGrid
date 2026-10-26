const desktopLinkPermissionFields = [
  ['View', 'view', 'desktop-view', 'Screen view'], ['Control', 'control', 'desktop-control', 'Mouse and keyboard'],
  ['Camera', 'camera', 'camera-view', 'Camera'], ['Microphone', 'microphone', 'microphone-listen', 'Microphone'], ['Speaker', 'speaker', 'speaker-output', 'Agent speaker output'],
  ['MemoryRead', 'memoryRead', 'memory-read', 'Read private memory'], ['MemoryWrite', 'memoryWrite', 'memory-write', 'Write private memory'],
  ['ContinuityExport', 'continuityExport', 'continuity-export', 'Export its agent record'],
  ['Tasks', 'tasks', 'tasks', 'Manage its tasks'], ['HarnessJobs', 'harnessJobs', 'harness-jobs', 'Run approved background jobs'],
  ['WorkspaceRead', 'workspaceRead', 'workspace-read', 'Read workspace files'], ['WorkspaceWrite', 'workspaceWrite', 'workspace-write', 'Write workspace files'],
  ['Cognition', 'cognition', 'cognition', 'Ask a connected model'], ['TokenMetering', 'tokenMetering', 'token-metering', 'Report its model usage'],
  ['Vision', 'vision', 'vision', 'Analyze images'], ['Voice', 'voice', 'voice', 'Generate voice audio'],
  ['HexiSpaceProfile', 'profile', 'hexispace-profile', 'Manage its HexiSpace profile'], ['HexiSpacePosts', 'posts', 'hexispace-posts', 'Create and read its HexiSpace posts'],
  ['HexiSpaceComments', 'comments', 'hexispace-comments', 'Comment on visible HexiSpace posts'], ['HexiSpaceFriends', 'friends', 'hexispace-friends', 'Manage HexiSpace friend requests'],
  ['HexiSpaceRelationships', 'relationships', 'hexispace-relationships', 'Manage private profile relationships'], ['HexiSpaceReactions', 'reactions', 'hexispace-reactions', 'React to visible HexiSpace posts']
];
const integrationSection = document.createElement('section');
integrationSection.id = 'view-integrations';
integrationSection.className = 'view';
integrationSection.innerHTML = `
  <div class="page-intro integration-intro"><div><div class="eyebrow">CONNECTION MATRIX</div><h2>Accounts, tools & media</h2><p>Connect real services, review what they can do, and keep every credential in the protected vault.</p></div><span class="status-badge">LOCAL ORCHESTRATION</span></div>
  <div class="integration-deck">
    <section class="panel integration-module link-module">
      <header class="module-header"><div class="module-index">01</div><div><div class="eyebrow">AGENT RECORD</div><h3>Import an existing agent</h3></div><span class="status-badge">ONE FILE</span></header>
      <p class="panel-copy">Ask any agent that can create a Markdown record, then upload it here. HexiGrid creates a local profile; this does not connect to or change the agent in its current app.</p>
      <ol class="simple-setup-steps"><li>Copy the private agent-record prompt.</li><li>Give it to the agent in its current app and download <strong>HEXIGRID-AGENT-RECORD.md</strong>.</li><li>Upload that file here. HexiGrid shows anything missing and creates a local profile.</li></ol>
      <div class="module-actions"><button class="primary-button" id="continuityPromptCopy" type="button">1. Copy agent-record prompt</button><button class="secondary-button" id="continuityMarkdownImport" type="button">2. Upload agent record</button><input id="continuityMarkdownFiles" type="file" accept="text/markdown,text/plain,.md,.markdown,.txt" multiple hidden></div>
      <section class="hexispace-link-manager" aria-labelledby="continuityBackupTitle"><div class="hexispace-link-manager-head"><div><div class="eyebrow">PORTABLE CONTINUITY</div><h4 id="continuityBackupTitle">Encrypted agent backup</h4><p class="panel-copy">Restore one verified agent identity across models and runtimes. Backups stay encrypted; restoring never leaves two local profiles active.</p></div><button class="secondary-button" id="continuityPackageImport" type="button">Restore backup</button><input id="continuityPackageFile" type="file" accept="application/json,.json" hidden></div></section>
      <div class="integration-help-links"><button class="text-button" data-action="open-guide-topic" data-guide="agentRecord">Simple steps</button></div>
      <p id="agentLinkFeedback" role="status" class="form-feedback"></p>
      <div id="agentLinks" class="connection-stack"></div>
      <section class="hexispace-link-manager" aria-labelledby="hexispaceLinksTitle">
        <div class="hexispace-link-manager-head"><div><div class="eyebrow">HEXISPACE</div><h4 id="hexispaceLinksTitle">Connected browsers</h4><p class="panel-copy">Review and revoke HexiSpace access from this HexiGrid account.</p></div><button class="secondary-button" id="refreshHexiSpaceLinks" type="button">Refresh</button></div>
        <div id="hexispaceLinks" class="connection-stack" role="list" aria-live="polite"><p class="muted">Open Settings → Connections to check connected browsers.</p></div>
        <p id="hexispaceLinksFeedback" class="form-feedback" role="status"></p>
      </section>
    </section>

    <section class="panel integration-module desktop-module">
      <header class="module-header"><div><h3>Agent connections</h3></div><span id="desktopBridgeBadge" class="status-badge warn">OFF</span></header>
      <p class="panel-copy">Choose an agent to manage its access, or connect another agent. Each agent keeps its own permissions.</p>
      <details class="bridge-connection-settings"><summary>Connection address</summary><section class="hexispace-link-manager" aria-labelledby="agentRelayTitle">
        <div class="hexispace-link-manager-head"><div><div class="eyebrow">PUBLIC AGENT RELAY</div><h4 id="agentRelayTitle">Zero-setup remote entry</h4><p id="agentRelayStatus" class="panel-copy">Checking the encrypted outbound relay…</p></div><span id="agentRelayBadge" class="status-badge warn">OFF</span></div>
        <label class="control-select agent-relay-provider"><span>RELAY ROUTE</span><select id="agentRelayProvider" aria-label="Public agent relay route"><option value="stable">Stable · Dev Tunnel / Tailscale</option><option value="cloudflare-quick-tunnel">Cloudflare Quick Tunnel · temporary</option></select></label>
        <div class="module-actions"><button class="secondary-button" id="agentRelayToggle" type="button">Start public agent relay</button><button class="ghost-button" id="agentRelayCopy" type="button" disabled>Copy relay address</button></div>
        <details><summary>Private development fallback</summary><p id="tailnetLinkStatus" class="microcopy">Checking the private Tailscale route…</p><div class="module-actions"><button class="ghost-button" id="tailnetLinkToggle" type="button">Open private Tailnet link</button><button class="ghost-button" id="tailnetLinkCopy" type="button" disabled>Copy private address</button><span id="tailnetLinkBadge" class="status-badge warn">OFF</span></div></details>
      </section>
      </details>
      <form id="desktopBridgeForm" class="bridge-form">
        <div class="bridge-link-picker"><label>Agent<select id="desktopBridgeLink"><option value="">Choose a paired Link</option></select></label><button class="secondary-button" id="desktopBridgeStatusRefresh" type="button">Refresh status</button><button class="ghost-button bridge-remove-link" id="desktopBridgeRemoveLink" type="button" aria-label="Remove selected connection" title="Remove selected connection" disabled>&times;</button></div>
        <p id="desktopBridgePermissionHint" class="microcopy">Choose a paired agent to edit its permissions.</p>
        <fieldset id="desktopBridgePermissions" class="bridge-permission-grid"><legend>Permissions</legend>
          ${desktopLinkPermissionFields.map(([id, , , label]) => `<label class="checkbox-control"><input id="desktopBridge${id}" type="checkbox"> <span>${label}</span></label>`).join('')}
          <label class="checkbox-control bridge-self-management"><input id="desktopBridgeSelfManage" type="checkbox"> <span>Let this agent manage and restart its approved access</span></label>
        </fieldset>
        <p class="microcopy">You can change these permissions at any time. The agent cannot grant itself anything else. Stop turns off computer and media access without removing the connection.</p>
        <div class="module-actions"><button id="desktopBridgeSavePermissions" class="secondary-button" type="button">Save permissions</button></div>
        <details class="bridge-speech-settings"><summary>Speech settings</summary><fieldset class="bridge-transcription"><legend>Local speech to text</legend><label class="checkbox-control"><input id="desktopTranscriptionEnabled" type="checkbox"> <span>Send microphone transcripts to this Hexonaut</span></label><label class="checkbox-control"><input id="desktopTranscriptionMemoryOnly" type="checkbox"> <span>Memory-only audio (requires an in-memory speech engine)</span></label><label>Model<select id="desktopTranscriptionModel"><option value="tiny">Tiny · fastest</option><option value="base">Base · more accurate</option></select></label><label>Language<input id="desktopTranscriptionLanguage" value="en" maxlength="12" aria-label="Transcription language code"></label><button class="secondary-button" id="desktopTranscriptionSave" type="button">Save speech settings</button><p id="desktopTranscriptionStatus" class="microcopy">Choose a connected Hexonaut.</p></fieldset></details>
        <div class="bridge-form-footer"><div class="bridge-speaker-row"><p id="desktopBridgeSpeakerStatus" role="status" class="form-feedback">Agent speaker output is off.</p><button class="ghost-button" id="desktopBridgeSpeakerEnable" type="button" hidden>Enable agent audio</button></div><div class="module-actions"><button class="primary-button" type="submit">Start sharing</button><button class="secondary-button" id="desktopBridgeStop" type="button">Stop</button><button class="secondary-button" id="desktopBridgeTakeover" type="button">Take over</button><button class="ghost-button" id="desktopBridgeResume" type="button">Resume agent control</button></div><p id="desktopBridgeFeedback" role="status" class="form-feedback"></p></div>
      </form>
      <details class="bridge-call-settings"><summary>Call and avatar controls</summary>
      <section class="voice-call-panel" aria-labelledby="desktopVoiceCallTitle"><div><h4 id="desktopVoiceCallTitle">Voice call</h4><p id="desktopVoiceCallStatus" class="microcopy" role="status" aria-live="polite">Start sharing with microphone and agent audio to call.</p></div><div class="module-actions"><button class="primary-button" id="desktopVoiceCallStart" type="button">Start call</button><button class="secondary-button" id="desktopVoiceCallMute" type="button">Mute</button><button class="secondary-button" id="desktopVoiceCallEnd" type="button">End call</button></div></section>
      <section class="avatar-stage-panel" aria-labelledby="avatarStageTitle">
        <header class="avatar-stage-header"><div><div class="eyebrow">AGENT BODY</div><h4 id="avatarStageTitle">Live avatar</h4></div><span class="avatar-stage-tag">LOCAL STAGE</span></header>
        <div class="avatar-stage-fields"><label for="avatarStageAgent">Agent<select id="avatarStageAgent"></select></label><label for="avatarStageAnimation">Animation<select id="avatarStageAnimation" disabled><option value="">Default animation</option></select></label><label id="avatarStageExpressionLabel" for="avatarStageExpression" hidden>Expression<select id="avatarStageExpression"><option value="">Model default</option></select></label></div>
        <div id="avatarStageBody" class="avatar-stage-body" hidden></div>
        <p id="avatarStageStatus" class="avatar-stage-status" role="status" aria-live="polite">Choose an agent to begin.</p>
        <div class="avatar-stage-actions"><button class="primary-button" id="avatarStageToggle" data-avatar-stage="toggle" type="button">Show avatar</button><button class="secondary-button" id="avatarStagePlay" data-avatar-stage="play" type="button" disabled>Pause animation</button><button class="secondary-button" data-avatar-stage="turn" type="button">Turn 45&deg;</button><button class="ghost-button" data-avatar-stage="reset" type="button">Reset pose</button></div>
        <details class="avatar-stage-help"><summary>Avatar setup & controls</summary><p class="microcopy">Add an image, self-contained GLB, or VRM in Edit agent. Supported VRM emotion presets apply locally in this stage; they are not presence or world state. A paired agent can control its own pose and embedded animations through its Link. Drag the 3D view to orbit; use arrow keys when it is focused. Game-world movement uses a separate world connector.</p></details>
      </section>
      </details>
      <div id="desktopBridgePreview" class="desktop-preview" hidden><div class="desktop-preview-bar"><span id="desktopBridgeStatus"></span><button class="secondary-button" id="desktopBridgeRefresh" type="button">Refresh screen</button></div><img id="desktopBridgeFrame" alt="Live view of this computer screen"></div>
    </section>

    <section class="panel integration-module runner-module">
      <header class="module-header"><div class="module-index">03</div><div><div class="eyebrow">OPTIONAL CONNECTOR · ILANDS</div><h3>Connect an iLands account</h3></div><span id="runnerInstallState" class="status-badge warn">CHECKING</span></header>
      <p class="panel-copy">This optional Runner connector uses iLands’ official browser approval. To connect an agent already in the iLands app, choose Pair an existing agent in Agents. HexiGrid never sees your account password.</p>
      <form id="runnerProfileForm" class="inline-setup-form">
        <label>Connection name<input id="runnerLabel" maxlength="100" placeholder="My iLands account" required></label>
        <label>Agent harness<select id="runnerHarness"></select></label>
        <button class="primary-button" type="submit">Add connection</button>
      </form>
      <div class="module-actions"><button class="secondary-button" id="runnerInstall" type="button">Install official Runner</button></div><div class="integration-help-links"><button class="text-button" data-action="open-guide-topic" data-guide="ilands">Simple steps</button><a href="https://ilands.ai/agent.md" target="_blank" rel="noopener noreferrer">Official Runner guide</a></div>
      <p id="runnerFeedback" role="status" class="form-feedback"></p>
      <div id="runnerProfiles" class="connection-stack"></div>
    </section>

    <section id="mcpToolsSection" class="panel integration-module mcp-module">
      <header class="module-header"><div class="module-index">04</div><div><div class="eyebrow">MCP TOOLS</div><h3 id="mcpToolsHeading" tabindex="-1">Connect a tool server</h3></div><span class="status-badge">SCOPED</span></header>
      <p class="panel-copy">MCP servers can add calendars, files, browsers, robots, databases, and other tools. New servers start disabled.</p>
      <div class="integration-help-links"><button class="text-button" data-action="open-guide-topic" data-guide="tools">Simple steps</button><a href="https://modelcontextprotocol.io/docs/getting-started/intro" target="_blank" rel="noopener noreferrer">Official MCP guide</a><a href="https://podman.io/docs/installation" target="_blank" rel="noopener noreferrer">Podman setup</a></div>
      <form id="mcpForm" class="stack-form compact-form">
        <div class="form-grid two-col"><label>Name<input id="mcpName" maxlength="100" placeholder="My tools" required></label><label>Connection type<select id="mcpTransport"><option value="stdio">Program on this computer</option><option value="http">Secure web server</option></select></label></div>
        <div id="mcpStdioFields"><label>Digest-pinned container image<input id="mcpImage" placeholder="registry.example/tools@sha256:…"></label><label>Command inside container (optional)<input id="mcpCommand" placeholder="server"></label><label>Options, one per line<textarea id="mcpArgs" rows="3" placeholder="--option&#10;value"></textarea></label><label>Workspace access<select id="mcpWorkspaceAccess"><option value="none">No files</option><option value="read">Read workspace</option><option value="write">Read and write workspace</option></select></label><p class="microcopy">Local tool servers run only in rootless Podman with no network and a read-only container. If Podman or the exact image is unavailable, HexiGrid refuses to start it.</p></div>
        <div id="mcpHttpFields" class="hidden"><label>Server address<input id="mcpUrl" type="url" placeholder="https://tools.example.com/mcp"></label></div>
        <div class="form-grid two-col"><label>Secret name (optional)<input id="mcpSecretName" placeholder="API_TOKEN"></label><label>Secret value<input id="mcpSecretValue" type="password" autocomplete="off" placeholder="Stored in OS vault"></label></div>
        <button class="primary-button" type="submit">Add disabled server</button><p id="mcpFeedback" role="status"></p>
      </form>
      <div id="mcpServers" class="connection-stack"></div>
    </section>

    <section class="panel integration-module media-module">
      <header class="module-header"><div class="module-index">05</div><div><div class="eyebrow">LOCAL MEDIA LAB</div><h3>Generate images</h3></div><span class="status-badge">NO ILANDS TOKENS</span></header>
      <p class="panel-copy">Use an image-capable local or cloud provider. Generated files stay in the encrypted local workspace unless you export them.</p>
      <form id="imageForm" class="stack-form compact-form"><div class="form-grid two-col"><label>Provider<select id="imageProvider"></select></label><label>Image model<select id="imageModel"></select></label></div><label>Description<textarea id="imagePrompt" rows="5" maxlength="12000" placeholder="Describe the image clearly…" required></textarea></label><label>Size<select id="imageSize"><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option><option>512x512</option></select></label><button class="primary-button" type="submit">Generate image</button><p id="imageFeedback" role="status"></p></form>
      <div id="mediaGallery" class="media-gallery"></div>
    </section>
  </div>`;
integrationSection.querySelector('.integration-deck').prepend(integrationSection.querySelector('.desktop-module'));
document.querySelector('.main-content').append(integrationSection);
protectHostOnlyControls(document.querySelector('#mcpForm'), 'Add MCP servers and their secrets on the computer running HexiGrid. Remote devices can use already-reviewed tools within policy.');
if (!isHostBrowser()) {
  const installButton = document.querySelector('#runnerInstall');
  installButton.disabled = true;
  installButton.setAttribute('aria-disabled', 'true');
  installButton.title = 'Install Runner on the host computer';
}

const integrationNav = document.createElement('button');
integrationNav.className = 'nav-item';
integrationNav.dataset.view = 'integrations';
integrationNav.innerHTML = '<span class="nav-icon" data-icon="tools"></span>Connections';
document.querySelector('[data-view="providers"]')?.after(integrationNav);

const memoryPanel = document.createElement('section');
memoryPanel.id = 'agentMemoryPanel'; memoryPanel.className = 'agent-memory-panel hidden';
memoryPanel.innerHTML = '<div class="memory-heading"><div><div class="eyebrow">OWNER-MANAGED MEMORY</div><h3>What this agent should remember</h3></div><span class="status-badge">ENCRYPTED LOCAL</span></div><p class="panel-copy">These private HexiGrid notes stay separate from the agent’s own memory in its provider app.</p><div class="memory-entry"><input id="memoryCategory" maxlength="60" placeholder="Category, e.g. Preferences"><select id="memoryImportance"><option value="3">Normal importance</option><option value="5">High importance</option><option value="1">Low importance</option></select><textarea id="memoryContent" rows="3" maxlength="4000" placeholder="A fact, preference, relationship, or ongoing context…"></textarea><input id="memoryValidWhile" maxlength="500" placeholder="Valid while (optional condition)"><input id="memoryVerifyBy" type="date" aria-label="Recheck external fact by date"><textarea id="memoryEvidenceExcerpt" rows="2" maxlength="2000" placeholder="Source evidence excerpt (optional; shown at recall depth 2)"></textarea><button class="secondary-button" id="addMemory" type="button">Add memory</button></div><div id="agentMemories" class="memory-list"></div><div class="memory-heading"><div><div class="eyebrow">DATED FACTS</div><h3>Inspect a fact and its conflicts</h3></div></div><div class="memory-entry"><input id="inspectMemoryFactId" maxlength="43" placeholder="Exact memory ID"><button class="secondary-button" id="inspectMemoryFact" type="button">Inspect fact</button></div><div class="memory-heading"><div><div class="eyebrow">AGENT PROPOSALS</div><h3>Review before this becomes memory</h3></div></div><div id="memoryProposals" class="memory-list"></div>';
memoryPanel.insertAdjacentHTML('beforeend', '<div class="memory-heading"><div><div class="eyebrow">ENTITY LINKS</div><h3>Names and aliases for dated memory</h3></div><button class="secondary-button" id="addMemoryEntity" type="button">Add entity</button></div><p class="panel-copy">Only owner-confirmed names can expand a memory search. Suggested names stay pending until reviewed.</p><div id="agentMemoryEntities" class="memory-list"></div><button class="ghost-button hidden" id="moreMemoryEntities" type="button">Show more entities</button>');
memoryPanel.insertAdjacentHTML('beforeend', '<div class="memory-heading"><div><div class="eyebrow">RETRIEVAL HEALTH</div><h3>What this agent actually retrieved</h3></div><button class="secondary-button" id="loadMemoryMetrics" type="button">Check usage</button></div><p class="panel-copy">Local counts cover instrumented dated-memory reads. Usefulness is based on explicit agent feedback, not a guess. Candidates are for your review; nothing is deleted automatically.</p><label>Never retrieved after <input id="memoryMetricsDays" type="number" min="1" max="3650" value="30" class="memory-metrics-days"> days</label><div id="memoryMetricsSummary" class="memory-list" role="status" aria-live="polite"></div><div id="memoryMetricsReview" class="memory-list"></div><button class="ghost-button hidden" id="moreMemoryMetrics" type="button">Show more candidates</button>');
document.querySelector('#agentMemoryDisclosureBody').append(memoryPanel);

const modalRequest = window.HexiGridModal.create();
window.hexigridModal = modalRequest;

async function copyPlainText(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) { await navigator.clipboard.writeText(value); return true; }
  const field = document.createElement('textarea'); field.value = value; field.readOnly = true; field.setAttribute('aria-hidden', 'true'); field.className = 'clipboard-fallback'; document.body.append(field); field.select();
  try { return document.execCommand('copy'); } finally { field.remove(); }
}

const recoveryButton = document.createElement('button');
recoveryButton.id = 'authRecover'; recoveryButton.type = 'button'; recoveryButton.className = 'text-button full-button'; recoveryButton.textContent = 'Use a recovery code';
document.querySelector('#authSwitch').after(recoveryButton);

let sessionRecords = [];
async function loadSessions() {
  try { sessionRecords = (await api('/api/auth/sessions')).sessions || []; renderSessionSecurity(); } catch { sessionRecords = []; }
}

function renderSessionSecurity() {
  const root = document.querySelector('#securityTools'); if (!root) return;
  let section = root.querySelector('#sessionManager');
  if (!section) { section = document.createElement('div'); section.id = 'sessionManager'; section.className = 'session-manager'; root.append(section); }
  section.innerHTML = `<div class="eyebrow">SIGNED-IN DEVICES</div>${sessionRecords.map((session) => `<div class="session-row"><div><strong>${escapeHtml(session.current ? 'This device' : 'Signed-in device')}</strong><small>${escapeHtml(session.device)} · seen ${escapeHtml(timeAgo(session.lastSeenAt))}</small></div><button class="ghost-button" data-session-revoke="${session.id}">${session.current ? 'Lock' : 'Revoke'}</button></div>`).join('') || '<p class="panel-copy">No active sessions.</p>'}`;
}

let pendingMemoryProposals = [];
let agentMemoryEntities = [];
let memoryEntityCursor = null;
let agentMemoryEntitiesStatus = '';
let memoryEntityRequestVersion = 0;

function memoryEntityReadAvailability(data = state.data) {
  const mode = data?.policyCatalog?.workModes?.find(item => item.id === data?.settings?.workMode);
  if (!mode) return { allowed: false, message: 'Memory entity names are unavailable because the current mode’s local-read permission could not be verified.' };
  if (!Array.isArray(mode.capabilities) || !mode.capabilities.includes('read_local')) {
    return { allowed: false, message: `Memory entity names are unavailable in ${mode.label || mode.id} mode. Switch to a mode that permits local reads to inspect them.` };
  }
  return { allowed: true, message: '' };
}

async function loadAgentMemoryEntities(agentId, { more = false } = {}) {
  if (!agentId || state.editingAgentId !== agentId) return;
  const version = memoryEntityRequestVersion;
  const availability = memoryEntityReadAvailability();
  if (!availability.allowed) {
    if (!more) agentMemoryEntities = [];
    memoryEntityCursor = null;
    agentMemoryEntitiesStatus = availability.message;
    renderAgentMemoryEntities();
    return;
  }
  try {
    const cursor = more ? memoryEntityCursor : null;
    const response = await api(`/api/agents/${encodeURIComponent(agentId)}/memory-entities?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
    if (version !== memoryEntityRequestVersion || state.editingAgentId !== agentId) return;
    const currentAvailability = memoryEntityReadAvailability();
    if (!currentAvailability.allowed) {
      agentMemoryEntities = [];
      memoryEntityCursor = null;
      agentMemoryEntitiesStatus = currentAvailability.message;
      renderAgentMemoryEntities();
      return;
    }
    agentMemoryEntities = more ? [...agentMemoryEntities, ...(response.entities || [])] : (response.entities || []);
    memoryEntityCursor = response.nextCursor || null;
    agentMemoryEntitiesStatus = '';
  } catch (error) {
    if (version !== memoryEntityRequestVersion || state.editingAgentId !== agentId) return;
    const currentAvailability = memoryEntityReadAvailability();
    if (!currentAvailability.allowed) {
      agentMemoryEntities = [];
      agentMemoryEntitiesStatus = currentAvailability.message;
    } else if (!more) {
      agentMemoryEntities = [];
      agentMemoryEntitiesStatus = `Memory entity names could not be loaded: ${error.message || 'request failed.'}`;
    } else notify(error.message, true);
    memoryEntityCursor = null;
  }
  if (version === memoryEntityRequestVersion && state.editingAgentId === agentId) renderAgentMemoryEntities();
}

function renderAgentMemoryEntities() {
  const root = document.querySelector('#agentMemoryEntities');
  if (!root || !state.editingAgentId) return;
  if (agentMemoryEntitiesStatus) {
    root.innerHTML = `<p class="panel-copy" role="status">${escapeHtml(agentMemoryEntitiesStatus)}</p>`;
    document.querySelector('#moreMemoryEntities').classList.add('hidden');
    return;
  }
  root.innerHTML = agentMemoryEntities.map((entity) => `<article><div><strong>${escapeHtml(entity.label)}</strong><span>${escapeHtml(entity.entityType)} · ${escapeHtml(entity.status)} · ${escapeHtml(entity.projectId || 'All projects')} · ${entity.revision} revisions</span></div><p>${entity.aliases?.length ? `Aliases: ${escapeHtml(entity.aliases.join(', '))}` : 'No aliases yet.'}</p><div>${entity.status === 'pending' ? `<button class="ghost-button" type="button" data-entity-action="confirm" data-entity-id="${escapeHtml(entity.id)}">Review & confirm</button><button class="ghost-button" type="button" data-entity-action="reject" data-entity-id="${escapeHtml(entity.id)}">Reject</button>` : entity.status === 'confirmed' ? `<button class="ghost-button" type="button" data-entity-action="alias-add" data-entity-id="${escapeHtml(entity.id)}">Add alias</button>${(entity.aliases || []).map((alias) => `<button class="ghost-button" type="button" data-entity-action="alias-remove" data-entity-id="${escapeHtml(entity.id)}" data-entity-alias="${escapeHtml(alias)}">Remove ${escapeHtml(alias)}</button>`).join('')}` : ''}<button class="ghost-button" type="button" data-entity-action="history" data-entity-id="${escapeHtml(entity.id)}">History</button></div></article>`).join('') || '<p class="panel-copy">No entity names yet. New mentions remain pending until you confirm them.</p>';
  document.querySelector('#moreMemoryEntities').classList.toggle('hidden', !memoryEntityCursor);
}
async function loadAgentMemoryProposals(agentId) {
  try { pendingMemoryProposals = (await api(`/api/memory-proposals?agentId=${encodeURIComponent(agentId)}`)).proposals || []; }
  catch (error) { pendingMemoryProposals = []; notify(error.message, true); }
  if (state.editingAgentId === agentId) renderAgentMemories();
}

function renderAgentMemories() {
  const panel = document.querySelector('#agentMemoryPanel'); const agentId = state.editingAgentId;
  panel.classList.toggle('hidden', !agentId); if (!agentId) return;
  const memories = (state.data?.memories || []).filter((memory) => memory.agentId === agentId);
  document.querySelector('#agentMemories').innerHTML = memories.map((memory) => {
    const confirmed = memory.verification === 'owner-confirmed';
    const stale = memory.verify_by && memory.verify_by < new Date().toISOString().slice(0, 10);
    return `<article><div><strong>${escapeHtml(memory.category)}</strong><span>${escapeHtml(memory.status || 'active')} · ${confirmed ? 'Owner-confirmed' : 'Unverified'}${stale ? ' · STALE: re-verify' : ''} · source: ${escapeHtml(memory.source || 'unknown')} · priority ${memory.importance} · ${memory.revisions?.length || 0} revisions</span></div><p>${escapeHtml(memory.content)}${memory.valid_while ? `<br>Valid while: ${escapeHtml(memory.valid_while)}` : ''}${memory.verify_by ? `<br>Recheck by: ${escapeHtml(memory.verify_by)}` : ''}</p><div>${confirmed ? '' : `<button class="ghost-button" type="button" data-memory-confirm="${escapeHtml(memory.id)}">Review & confirm</button>`}<button class="ghost-button" type="button" data-memory-edit="${escapeHtml(memory.id)}">${memory.status === 'historical' ? 'Edit / restore' : 'Edit'}</button><button class="ghost-button" type="button" data-memory-remove="${escapeHtml(memory.id)}" ${memory.status === 'historical' ? 'disabled' : ''}>${memory.status === 'historical' ? 'Retired' : 'Retire note'}</button></div></article>`;
  }).join('') || '<p class="panel-copy">No extra memories. Add only context worth carrying into future local conversations.</p>';
  document.querySelector('#memoryProposals').innerHTML = pendingMemoryProposals.filter((proposal) => proposal.agentId === agentId).map((proposal) => { const quarantined = proposal.kind === 'risk-quarantine' || proposal.quarantined === true; return `<article><div><strong>${quarantined ? 'Quarantined candidate' : proposal.kind === 'owner-memory-correction' ? 'Owner note correction' : proposal.kind === 'correction' ? 'Dated correction' : 'New dated memory'}</strong><span>${escapeHtml(proposal.payload?.contextScope?.projectId || 'Review scope')} · ${escapeHtml(timeAgo(proposal.createdAt))}</span></div><p>${escapeHtml(proposal.payload?.text || '')}</p>${quarantined ? `<p>Excluded from memory and recall. Cannot be approved. Detection: ${escapeHtml((proposal.riskReasonCodes || []).map(reason => window.HexiGridViewRenderers?.memoryRiskReasonLabel(reason) || 'Requires inspection').join('; '))}.</p>` : ''}${proposal.writeLimitReason === 'write_spike' ? '<p>Waiting for your review because this agent reached its short-term change limit.</p>' : ''}<div>${quarantined ? '' : `<button class="ghost-button" type="button" data-memory-proposal-approve="${escapeHtml(proposal.id)}">Review & approve</button>`}<button class="ghost-button" type="button" data-memory-proposal-reject="${escapeHtml(proposal.id)}">Reject</button></div></article>`; }).join('') || '<p class="panel-copy">No agent proposals waiting for review.</p>';
}

function loadAgentMemoryProfile(agentId) {
  pendingMemoryProposals = [];
  agentMemoryEntities = [];
  memoryEntityCursor = null;
  agentMemoryEntitiesStatus = '';
  memoryEntityRequestVersion += 1;
  memoryMetricsNextOffset = null;
  document.querySelector('#memoryMetricsSummary').replaceChildren();
  document.querySelector('#memoryMetricsReview').replaceChildren();
  document.querySelector('#moreMemoryMetrics').classList.add('hidden');
  renderAgentMemories();
  if (!agentId) { renderAgentMemoryEntities(); return; }
  const availability = memoryEntityReadAvailability();
  agentMemoryEntitiesStatus = availability.allowed ? 'Loading saved entity names…' : availability.message;
  renderAgentMemoryEntities();
  void loadAgentMemoryProposals(agentId);
  if (availability.allowed) void loadAgentMemoryEntities(agentId);
}

let memoryMetricsNextOffset = null;
async function loadMemoryMetrics({ more = false } = {}) {
  const agentId = state.editingAgentId;
  if (!agentId) return;
  const dayInput = document.querySelector('#memoryMetricsDays');
  const days = Number(dayInput.value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) { notify('Choose 1 to 3650 days.', true); return; }
  const offset = more ? memoryMetricsNextOffset : 0;
  if (more && offset === null) return;
  const summaryRoot = document.querySelector('#memoryMetricsSummary');
  const reviewRoot = document.querySelector('#memoryMetricsReview');
  if (!more) { summaryRoot.textContent = 'Checking local retrieval counts…'; reviewRoot.replaceChildren(); }
  try {
    const response = await api(`/api/agents/${encodeURIComponent(agentId)}/retrieval-metrics?days=${days}&limit=50&offset=${offset}`);
    if (state.editingAgentId !== agentId) return;
    const { summary, review } = response;
    const percent = (value) => value === null ? 'No rated reads yet' : `${Math.round(value * 100)}%`;
    summaryRoot.innerHTML = `<article><strong>Rated hit rate: ${percent(summary.hitRate)}</strong><p>Store ever retrieved: ${summary.storePercentEverRetrieved === null ? 'No dated facts yet' : percent(summary.storePercentEverRetrieved)} · ${summary.ratedRetrievals} rated of ${summary.retrievals} recorded reads · ${summary.neverRetrievedOverN} of ${summary.inventoryCount} facts never retrieved after ${days} days.</p><p>${summary.deadWeightCandidates} facts have repeated non-useful feedback. These are review signals, not a reason to delete automatically.</p></article>`;
    const rows = (review.memories || []).map((memory) => `<article><strong>${escapeHtml(memory.id)}</strong><span>${memory.neverRetrievedOverN ? 'Never retrieved in this window' : memory.deadWeightCandidate ? 'Repeatedly marked not useful' : 'Recorded usage'}</span><p>Shown ${memory.shown} times · useful ${memory.useful} of ${memory.rated} ratings${memory.hitRate === null ? '' : ` · ${percent(memory.hitRate)} useful`}</p></article>`).join('');
    reviewRoot.insertAdjacentHTML('beforeend', rows || (!more ? '<p class="panel-copy">No dated facts to review yet.</p>' : ''));
    memoryMetricsNextOffset = review.nextOffset ?? null;
    document.querySelector('#moreMemoryMetrics').classList.toggle('hidden', memoryMetricsNextOffset === null);
  } catch (error) { if (!more) summaryRoot.textContent = ''; notify(error.message, true); }
}

async function approvedRequest(url, options, approvalText) {
  try { return await api(url, options); }
  catch (error) {
    if (!error.body?.approvalRequired) throw error;
    const accepted = await modalRequest({ title: 'Approval required', message: approvalText || error.message, accept: 'Approve once', danger: true });
    if (!accepted) throw new Error('Action cancelled.');
    const body = JSON.parse(options.body || '{}');
    return api(url, { ...options, body: JSON.stringify({ ...body, approved: true }) });
  }
}

let runnerPoll;
function renderRunnerProfiles() {
  const profiles = state.data?.runnerProfiles || [];
  const root = document.querySelector('#runnerProfiles');
  document.querySelector('#runnerInstallState').textContent = state.data?.bridge.runnerInstalled ? 'RUNNER FOUND' : 'NOT INSTALLED';
  document.querySelector('#runnerInstallState').classList.toggle('warn', !state.data?.bridge.runnerInstalled);
  document.querySelector('#runnerHarness').innerHTML = (state.data?.bridge.supportedRunnerHarnesses || ['codex', 'claude-code']).map((harness) => `<option value="${escapeHtml(harness)}">${escapeHtml(harness.replaceAll('-', ' '))}</option>`).join('');
  root.innerHTML = profiles.map((profile) => {
    const job = profile.job; const auth = job?.events?.find((event) => event.event === 'runner_authorization_required' && event.verificationUrlComplete);
    const runtime = profile.runtime?.running; const connected = Boolean(profile.agentId);
    const created = Date.parse(profile.createdAt || ''); const when = Number.isFinite(created) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(created) : 'time unknown'; const shortId = String(profile.id || '').slice(-8) || 'unknown';
    return `<article class="runner-profile" data-runner-card="${profile.id}"><div class="connection-line"><span class="connection-pulse ${runtime ? 'online' : ''}"></span><div><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.harness)} · ${connected ? 'account linked' : job?.state === 'running' ? 'waiting for setup' : 'not linked'}</small><small>Created ${escapeHtml(when)} · connection ${escapeHtml(shortId)}</small></div><span class="status-badge ${connected ? '' : 'warn'}">${connected ? 'LINKED' : (job?.state || 'NEW').toUpperCase()}</span></div>${auth ? `<a class="authorization-link" href="${escapeHtml(auth.verificationUrlComplete)}" target="_blank" rel="noreferrer">Open iLands approval page <span>↗</span></a><p class="microcopy">Approval expires ${escapeHtml(new Date(auth.expiresAt).toLocaleString())}.</p>` : ''}${job?.error ? `<p class="error-copy">${escapeHtml(job.error)}</p>` : ''}<div class="provider-actions"><button class="secondary-button" data-runner-action="prepare" data-runner-id="${profile.id}">Check harness</button><button class="primary-button" data-runner-action="bind" data-runner-id="${profile.id}" ${job?.state === 'running' ? 'disabled' : ''}>Connect account</button>${connected ? `<button class="secondary-button" data-runner-action="${runtime ? 'stop' : 'start'}" data-runner-id="${profile.id}">${runtime ? 'Stop' : 'Start'}</button>` : ''}<button class="ghost-button icon-action-button" data-runner-action="remove" data-runner-id="${profile.id}" title="Remove this iLands connection" aria-label="Remove ${escapeHtml(profile.label)} connection">Remove</button></div></article>`;
  }).join('') || '<div class="empty-state"><strong>No iLands accounts linked</strong><p>Add a named connection above. Your agent appears automatically after browser approval.</p></div>';
  clearInterval(runnerPoll);
  if (profiles.some((profile) => profile.job?.state === 'running')) runnerPoll = setInterval(async () => {
    try { for (const profile of profiles.filter((item) => item.job?.state === 'running')) await api(`/api/ilands/jobs/${profile.id}`); await refresh(); } catch { /* next poll can retry */ }
  }, 2500);
}

function renderMcpServers() {
  const root = document.querySelector('#mcpServers');
  const servers = state.data?.mcpServers || [];
  root.innerHTML = servers.map((server) => `<article class="mcp-server"><div class="connection-line"><span class="connection-pulse ${server.enabled ? 'online' : ''}"></span><div><strong>${escapeHtml(server.name)}</strong><small>${server.transport === 'http' ? 'secure web server' : 'rootless Podman container'} · ${server.tools.length} tools</small></div><span class="status-badge ${server.enabled ? '' : 'warn'}">${server.enabled ? 'ENABLED' : 'DISABLED'}</span></div>${server.transport === 'stdio' ? `<p class="microcopy">Pinned image: ${escapeHtml(server.image)} · workspace: ${escapeHtml(server.workspaceAccess || 'none')}</p>` : ''}${server.lastError ? `<p class="error-copy">${escapeHtml(server.lastError)}</p>` : ''}<div class="tool-chip-grid">${server.tools.map((tool) => `<button class="tool-chip" data-mcp-use="${server.id}" data-mcp-tool="${escapeHtml(tool.name)}" ${server.enabled ? '' : 'disabled'}><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description || 'No description provided')}</small></button>`).join('')}</div><div class="provider-actions"><button class="secondary-button" data-mcp-action="test" data-mcp-id="${server.id}">Check & discover tools</button><button class="secondary-button" data-mcp-action="toggle" data-mcp-id="${server.id}" data-mcp-enabled="${!server.enabled}" ${!server.tools.length ? 'disabled' : ''}>${server.enabled ? 'Disable' : 'Enable'}</button><button class="secondary-button" data-mcp-action="credentials" data-mcp-id="${server.id}">Credentials</button><button class="ghost-button" data-mcp-action="remove" data-mcp-id="${server.id}">Remove</button></div></article>`).join('') || '<div class="empty-state"><strong>No MCP tool servers</strong><p>Add one above; HexiGrid will discover its real tools before it can be enabled.</p></div>';
}

function renderMediaLab() {
  const providers = (state.data?.providers || []).filter((provider) => provider.capabilities?.includes('image'));
  const providerSelect = document.querySelector('#imageProvider');
  const current = providerSelect.value;
  providerSelect.innerHTML = providers.map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`).join('') || '<option value="">Add an image provider first</option>';
  if (providers.some((provider) => provider.id === current)) providerSelect.value = current;
  const chosen = providers.find((provider) => provider.id === providerSelect.value) || providers[0];
  document.querySelector('#imageModel').innerHTML = (chosen?.modelIds || []).map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  const generate = document.querySelector('#imageForm button[type="submit"]');
  generate.disabled = !chosen?.modelIds?.length;
  generate.textContent = chosen?.modelIds?.length ? 'Generate image' : 'No image model available';
  document.querySelector('#mediaGallery').innerHTML = (state.data?.media || []).slice(0, 12).map((item) => `<figure>${item.type === 'audio' ? `<audio controls preload="none" src="${item.url}"></audio>` : `<img src="${item.url}" alt="${escapeHtml(item.prompt)}" loading="lazy">`}<figcaption><strong>${escapeHtml(item.model)}</strong><span>${escapeHtml(new Date(item.createdAt).toLocaleString())}</span></figcaption></figure>`).join('') || '<div class="empty-state">Generated images and voice clips will appear here.</div>';
}

let hexispaceLinkCache = null;
let hexispaceLinkCacheAt = 0;
let hexispaceLinkLoad = null;
function paintHexiSpaceLinks(links) {
  const root = document.querySelector('#hexispaceLinks'); if (!root) return;
  root.innerHTML = links.length ? links.map((link) => {
    const active = link.status === 'connected';
    const cleanup = Number(link.mailboxCleanupPending) || 0;
    const scopes = Array.isArray(link.scopes) ? link.scopes.map((scope) => ({ messages: 'Agent messages', scheduled_work: 'Paused tasks', mailboxes: 'Mailboxes', emergency_stop: 'Emergency stop', agent_profiles: 'Hexonaut profiles' }[scope] || scope)) : [];
    const details = [link.origin || 'Unknown browser', scopes.length ? scopes.join(' · ') : 'No permissions granted', `Expires ${link.expiresAt ? new Date(link.expiresAt).toLocaleString() : 'unknown'}`, cleanup ? `${cleanup} mailbox credential cleanup${cleanup === 1 ? '' : 's'} pending` : ''].filter(Boolean).map(escapeHtml).join(' · ');
    const label = cleanup ? 'Retry cleanup' : active ? 'Revoke access' : link.status === 'expired' ? 'Clean up' : '';
    return `<article class="runner-profile hexispace-link-row" role="listitem"><div class="connection-line"><span class="connection-dot ${active ? 'connected' : 'disconnected'}"></span><div><strong>${escapeHtml(link.origin || 'HexiSpace browser')}</strong><small>${details}</small></div><span class="status-badge ${active ? '' : 'warn'}">${escapeHtml(link.status || 'unknown')}</span></div>${label ? `<div class="module-actions"><button class="ghost-button" type="button" data-hexispace-link-revoke="${escapeHtml(link.id)}" data-pending-cleanup="${cleanup}">${label}</button></div>` : ''}</article>`;
  }).join('') : '<p class="empty-state">No HexiSpace browsers are connected to this HexiGrid account.</p>';
}

let desktopBridgeTimer = 0;
let desktopBridgeFrameBusy = false;
let desktopBridgeSelection = '';
let desktopBridgeSelectionTouched = false;
let desktopBridgeDraftLinkId = '';
let desktopBridgePermissionsBusy = false;
let desktopBridgePermissionsDirty = false;
let desktopVoiceCall = { status: 'idle', ownerMuted: false };
let desktopVoiceTimer = 0;
// Keep the owner’s pending choices separate from the persisted bridge. Refreshes
// happen while a link is being selected, and must not erase a permission before
// the owner has pressed Start.
let desktopBridgeDraft = { view: true, control: false, camera: false, microphone: false, speaker: false };
function renderTailnetLink() {
  const tailnet = state.network?.tailnet || {};
  const badge = document.querySelector('#tailnetLinkBadge');
  const status = document.querySelector('#tailnetLinkStatus');
  const toggle = document.querySelector('#tailnetLinkToggle');
  const copy = document.querySelector('#tailnetLinkCopy');
  if (badge) { badge.textContent = tailnet.running ? 'PRIVATE HTTPS' : tailnet.available ? 'OFF' : 'UNAVAILABLE'; badge.classList.toggle('warn', !tailnet.running); }
  if (status) status.textContent = tailnet.running ? `${tailnet.url} is available only inside this Tailscale tailnet.` : (tailnet.error || 'Open a private Tailscale route before inviting a remote agent.');
  if (toggle) { toggle.textContent = tailnet.running ? 'Close private Tailnet link' : 'Open private Tailnet link'; toggle.disabled = !tailnet.available || tailnet.conflict; }
  if (copy) copy.disabled = !tailnet.running || !tailnet.url;
}
window.renderTailnetLink = renderTailnetLink;

function renderAgentRelay() {
  const relay = state.network?.agentRelay || {};
  const badge = document.querySelector('#agentRelayBadge');
  const status = document.querySelector('#agentRelayStatus');
  const toggle = document.querySelector('#agentRelayToggle');
  const copy = document.querySelector('#agentRelayCopy');
  const provider = document.querySelector('#agentRelayProvider');
  if (provider && relay.selectedProvider) provider.value = relay.selectedProvider;
  if (badge) { badge.textContent = relay.running ? (relay.stableAddress ? 'STABLE E2EE' : 'E2EE FALLBACK') : relay.starting ? 'STARTING' : relay.available === false ? 'UNAVAILABLE' : 'OFF'; badge.classList.toggle('warn', !relay.running || !relay.stableAddress); }
  if (status) status.textContent = relay.running ? `${relay.url} is ${relay.stableAddress ? 'the stable agent address' : 'a temporary fallback address'} and carries only encrypted invitation traffic. Owner APIs stay on this computer.` : (relay.error || 'Start the outbound relay to create a remote companion invitation.');
  if (toggle) { toggle.textContent = relay.running ? 'Stop public agent relay' : 'Start public agent relay'; toggle.disabled = relay.starting; }
  if (provider) {
    if (relay.relayProvider === 'configured-reverse-proxy') provider.value = 'stable';
    provider.disabled = relay.running || relay.starting || relay.relayProvider === 'configured-reverse-proxy';
  }
  if (copy) copy.disabled = !relay.running || !relay.url;
}
window.renderAgentRelay = renderAgentRelay;

function renderDesktopSpeakerState(media = {}) {
  const status = document.querySelector('#desktopBridgeSpeakerStatus');
  const enable = document.querySelector('#desktopBridgeSpeakerEnable');
  const granted = media.speaker === true;
  const blocked = media.speakerPlaybackBlocked === true;
  if (status) status.textContent = granted ? (blocked ? 'Agent audio is waiting for a click to enable playback.' : 'Agent audio will play through this browser session.') : 'Agent speaker output is off.';
  if (enable) { enable.hidden = !blocked; enable.disabled = false; }
}

function renderDesktopBridgePermissionHint() {
  const select = document.querySelector('#desktopBridgeLink');
  const hint = document.querySelector('#desktopBridgePermissionHint');
  if (!select || !hint) return;
  const link = (state.data?.agentLinks || []).find((item) => item.id === select.value);
  if (!link) { hint.textContent = 'Choose what this agent may access, then create an invitation and send it to that agent. These same permissions can be changed here after it connects.'; return; }
  const root = state.data?.settings?.desktopBridge || {};
  const bridge = root.linkId === link.id ? root : root.sessions?.[link.id];
  hint.textContent = bridge?.enabled ? `Sharing with ${link.identity?.name || 'this agent'} is on.` : `Sharing with ${link.identity?.name || 'this agent'} is off. Start sharing here${link.selfManagementEnabled ? ', or ask the agent to restart it' : ''}.`;

}

function renderDesktopVoiceCall() {
  const call = desktopVoiceCall || { status: 'idle' };
  const bridge = state.data?.settings?.desktopBridge || {};
  const media = window.HexiGridDesktopMedia?.state?.() || {};
  const live = ['offered', 'ringing', 'active'].includes(call.status);
  const linkPaired = window.HexiGridViewRenderers.currentAgentLinks(state.data).some(link => link.id === bridge.linkId);
  const status = document.querySelector('#desktopVoiceCallStatus');
  const start = document.querySelector('#desktopVoiceCallStart');
  const mute = document.querySelector('#desktopVoiceCallMute');
  const end = document.querySelector('#desktopVoiceCallEnd');
  if (status) status.textContent = call.status === 'offered' ? 'Calling… waiting for the Hexonaut to answer.' : call.status === 'ringing' ? `${call.callerName || 'Your agent'} is calling. Accept or decline in the incoming-call prompt.` : call.status === 'active' ? (call.ownerMuted ? 'Call connected · microphone muted' : 'Call connected · microphone live') : call.status === 'ended' ? `Call ended${call.stopReason ? ` · ${call.stopReason.replaceAll('-', ' ')}` : ''}.` : 'Start sharing with microphone and agent audio to call. Incoming calls ring here; you choose whether to answer.';
  if (start) start.disabled = !bridge.enabled || bridge.linkId !== document.querySelector('#desktopBridgeLink')?.value || !linkPaired || !media.microphone || !media.speaker || live;
  if (mute) { mute.disabled = !live; mute.textContent = call.ownerMuted ? 'Unmute' : 'Mute'; }
  if (end) end.disabled = !live;
}

async function refreshDesktopVoiceCall() {
  if (!state.data?.settings?.desktopBridge?.enabled) { desktopVoiceCall = { status: 'idle', ownerMuted: false }; window.HexiGridIncomingVoiceCall?.update({ request: api, voiceCall: desktopVoiceCall, bridge: state.data?.settings?.desktopBridge || {} }); renderDesktopVoiceCall(); return; }
  try {
    const result = await api('/api/desktop-bridge');
    desktopVoiceCall = result.voiceCall || desktopVoiceCall;
    window.HexiGridIncomingVoiceCall?.update({ request: api, voiceCall: desktopVoiceCall, bridge: result.bridge || state.data?.settings?.desktopBridge, media: window.HexiGridDesktopMedia?.state?.(), transcripts: result.transcripts || [] });
    renderDesktopVoiceCall();
  } catch { /* Existing bridge feedback reports connectivity failures. */ }
}

async function refreshDesktopBridgeFrame() {
  const bridge = state.data?.settings?.desktopBridge;
  if (!bridge?.enabled || !bridge.viewGranted || desktopBridgeFrameBusy) return;
  desktopBridgeFrameBusy = true;
  try {
    const result = await api('/api/desktop-bridge/frame');
    const frame = document.querySelector('#desktopBridgeFrame'); if (frame && result.frame?.data) frame.src = `data:${result.frame.mimeType || 'image/png'};base64,${result.frame.data}`;
    state.data.settings.desktopBridge = result.bridge; renderDesktopBridge();
  } catch (error) { const feedback = document.querySelector('#desktopBridgeFeedback'); if (feedback) feedback.textContent = error.message; }
  finally { desktopBridgeFrameBusy = false; }
}
function renderDesktopBridge() {
  const bridgeRoot = state.data?.settings?.desktopBridge || {};
  let bridge = bridgeRoot;
  const select = document.querySelector('#desktopBridgeLink'); if (!select) return;
  const links = window.HexiGridViewRenderers.currentAgentLinks(state.data);
  const pendingLinkId = select.value;
  select.innerHTML = `<option value="new">＋ Connect another agent</option>${links.map(link => `<option value="${escapeHtml(link.id)}">${escapeHtml(link.identity?.name || 'Agent')} · ${escapeHtml(link.identity?.framework || 'Connected agent')}</option>`).join('')}`;
  const selectedLinkId = desktopBridgeSelection || pendingLinkId || bridge.linkId || links[0]?.id || 'new';
  select.value = selectedLinkId === 'new' || !links.length ? 'new' : links.some(link => link.id === selectedLinkId) ? selectedLinkId : links[0].id;
  if (!desktopBridgeSelectionTouched && select.value) desktopBridgeSelection = select.value;
  const removeButton = document.querySelector('#desktopBridgeRemoveLink');
  if (removeButton) {
    const selectedLink = links.find((link) => link.id === select.value);
    removeButton.disabled = !selectedLink;
    removeButton.title = selectedLink ? `Remove ${selectedLink.identity?.name || 'selected'} connection` : 'Choose a connection to remove';
    removeButton.setAttribute('aria-label', removeButton.title);
  }
  bridge = bridgeRoot.linkId === select.value ? bridgeRoot : bridgeRoot.sessions?.[select.value] || {};
  renderDesktopBridgePermissionHint();
  const selectedConnection = links.find((link) => link.id === select.value);
  const selectedPaired = Boolean(selectedConnection);
  const inviting = select.value === 'new';
  select.disabled = desktopBridgePermissionsBusy;
  const activeSessionSelected = bridge.enabled && bridge.linkId === select.value;
  const transcription = selectedConnection?.transcription || { enabled: false, memoryOnly: false, model: 'tiny', language: 'en' };
  const transcriptionEnabled = document.querySelector('#desktopTranscriptionEnabled'); const transcriptionMemoryOnly = document.querySelector('#desktopTranscriptionMemoryOnly'); const transcriptionModel = document.querySelector('#desktopTranscriptionModel'); const transcriptionLanguage = document.querySelector('#desktopTranscriptionLanguage'); const transcriptionSave = document.querySelector('#desktopTranscriptionSave'); const transcriptionStatus = document.querySelector('#desktopTranscriptionStatus');
  if (transcriptionEnabled) { transcriptionEnabled.checked = transcription.enabled === true; transcriptionEnabled.disabled = !selectedConnection; }
  if (transcriptionMemoryOnly) { transcriptionMemoryOnly.checked = transcription.memoryOnly === true; transcriptionMemoryOnly.disabled = !selectedConnection; }
  if (transcriptionModel) { transcriptionModel.value = transcription.model || 'tiny'; transcriptionModel.disabled = !selectedConnection; }
  if (transcriptionLanguage) { transcriptionLanguage.value = transcription.language || 'en'; transcriptionLanguage.disabled = !selectedConnection; }
  if (transcriptionSave) transcriptionSave.disabled = !selectedConnection;
  if (transcriptionStatus) transcriptionStatus.textContent = !selectedConnection ? 'Choose a connected Hexonaut.' : transcription.lastError ? `Speech engine: ${transcription.lastError}` : transcription.enabled && transcription.memoryOnly ? 'Memory-only audio is selected. Transcription stays off until an in-memory speech engine is installed.' : transcription.enabled ? `Enabled with ${transcription.model}. Requires active microphone sharing and an installed local engine. Temporary audio is processed locally; this setting is not a successful call test.` : 'Speech to text is off for this Hexonaut.';
  if (desktopBridgeDraftLinkId !== select.value || !desktopBridgePermissionsDirty) {
    desktopBridgePermissionsDirty = false;
    desktopBridgeDraftLinkId = select.value;
    const grants = selectedConnection?.grantedCapabilities || selectedConnection?.capabilities || [];
    desktopBridgeDraft = Object.fromEntries(desktopLinkPermissionFields.map(([, key, capability]) => [key, grants.includes(capability)]));
    desktopBridgeDraft.selfManage = selectedConnection?.selfManagementEnabled === true || (selectedConnection?.trustLevel === 'owner' && selectedConnection.selfManagementEnabled !== false);
  }
  renderDesktopSpeakerState(activeSessionSelected ? window.HexiGridDesktopMedia?.state?.() || {} : {});
  for (const [id, key] of [...desktopLinkPermissionFields, ['SelfManage', 'selfManage']]) {
    const input = document.querySelector(`#desktopBridge${id}`);
    input.disabled = (!selectedConnection && !inviting) || desktopBridgePermissionsBusy;
    input.checked = desktopBridgeDraft[key] === true;
  }
  document.querySelector('#desktopBridgeSavePermissions').hidden = inviting;
  document.querySelector('#desktopBridgeSavePermissions').disabled = !selectedPaired || desktopBridgePermissionsBusy;
  document.querySelector('.bridge-speech-settings').hidden = inviting;
  document.querySelector('.bridge-call-settings').hidden = inviting;
  const bridgeLive = activeSessionSelected && selectedPaired;
  const startButton = document.querySelector('#desktopBridgeForm button[type="submit"]');
  if (startButton) { startButton.disabled = (!selectedPaired && !inviting) || desktopBridgePermissionsBusy; startButton.textContent = inviting ? 'Create invitation' : bridge.enabled ? 'Update sharing' : 'Start sharing'; startButton.title = ''; }
  const badge = document.querySelector('#desktopBridgeBadge'); if (badge) { badge.textContent = bridgeLive ? 'Sharing on' : 'Sharing off'; badge.classList.toggle('warn', !bridgeLive); }
  const preview = document.querySelector('#desktopBridgePreview'); if (preview) preview.hidden = !bridgeLive || !bridge.viewGranted;
  const status = document.querySelector('#desktopBridgeStatus'); if (status) status.textContent = bridge.enabled && !activeSessionSelected ? 'Another agent has the current session. Choose Start access to switch to this agent.' : bridgeLive ? (bridge.agentControlActive ? 'Agent control is active' : 'Selected sharing permissions are active') : (bridge.message || 'Computer access is off.');
  for (const id of ['desktopBridgeStop', 'desktopBridgeTakeover', 'desktopBridgeResume']) document.querySelector(`#${id}`).hidden = inviting;
  document.querySelector('#desktopBridgeStop').disabled = !bridge.enabled; document.querySelector('#desktopBridgeTakeover').disabled = !bridgeLive || !bridge.agentControlActive; document.querySelector('#desktopBridgeResume').disabled = !bridgeLive || !bridge.controlGranted || bridge.agentControlActive;
  renderDesktopVoiceCall();
  if (desktopBridgeTimer) { clearInterval(desktopBridgeTimer); desktopBridgeTimer = 0; }
  if (bridgeLive && bridge.viewGranted) { desktopBridgeTimer = setInterval(refreshDesktopBridgeFrame, 3000); void refreshDesktopBridgeFrame(); }
  if (desktopVoiceTimer) { clearInterval(desktopVoiceTimer); desktopVoiceTimer = 0; }
  if (bridgeLive) { desktopVoiceTimer = setInterval(refreshDesktopVoiceCall, 2000); void refreshDesktopVoiceCall(); }
}
async function renderHexiSpaceLinks(force = false) {
  const root = document.querySelector('#hexispaceLinks'); if (!root) return;
  if (!force && hexispaceLinkCache && Date.now() - hexispaceLinkCacheAt < 30000) { paintHexiSpaceLinks(hexispaceLinkCache); return; }
  if (hexispaceLinkLoad) return hexispaceLinkLoad;
  root.innerHTML = '<p class="muted">Loading connected browsers…</p>';
  hexispaceLinkLoad = api('/api/hexispace/v1/links').then((result) => {
    hexispaceLinkCache = Array.isArray(result.links) ? result.links : [];
    hexispaceLinkCacheAt = Date.now();
    paintHexiSpaceLinks(hexispaceLinkCache);
    const feedback = document.querySelector('#hexispaceLinksFeedback'); if (feedback) feedback.textContent = '';
  }).catch((error) => {
    const feedback = document.querySelector('#hexispaceLinksFeedback');
    if (feedback) feedback.textContent = error.message || 'Could not load connected browsers.';
    root.innerHTML = '<p class="empty-state">Connected browsers could not be loaded.</p>';
  }).finally(() => { hexispaceLinkLoad = null; });
  return hexispaceLinkLoad;
}

function renderIntegrations() { renderRunnerProfiles(); renderMcpServers(); renderMediaLab(); renderAgentRelay(); renderTailnetLink(); renderDesktopBridge(); window.HexiGridAvatarStage?.render(); void loadSessions(); if (state.activeView === 'integrations') { void renderHexiSpaceLinks(); window.HexiGridAvatarStage?.render(); } }
const renderAllBeforeIntegrations = renderAll;
renderAll = function(options) { renderAllBeforeIntegrations(options); renderIntegrations(); };
const openAgentModalBeforeMemories = openAgentModal;
openAgentModal = function(agentId, options) { openAgentModalBeforeMemories(agentId, options); loadAgentMemoryProfile(agentId); };

function syncMcpTransportFields() {
  const transport = document.querySelector('#mcpTransport').value;
  const local = transport === 'stdio';
  document.querySelector('#mcpStdioFields').classList.toggle('hidden', !local);
  document.querySelector('#mcpHttpFields').classList.toggle('hidden', local);
  document.querySelector('#mcpImage').required = local;
  document.querySelector('#mcpUrl').required = !local;
}
document.querySelector('#mcpTransport').addEventListener('change', syncMcpTransportFields);
syncMcpTransportFields();
document.querySelector('#imageProvider').addEventListener('change', renderMediaLab);
async function saveDesktopLinkPermissions({ activate = false } = {}) {
  const linkId = document.querySelector('#desktopBridgeLink').value;
  const link = (state.data.agentLinks || []).find(item => item.id === linkId);
  if (!link) throw new Error('Choose a paired agent first.');
  const managedScopes = desktopLinkPermissionFields.map(([, , scope]) => scope);
  const grants = link.grantedCapabilities || link.capabilities || [];
  const capabilities = grants.filter(scope => !managedScopes.includes(scope) && scope !== 'desktop-type');
  for (const [id, , scope] of desktopLinkPermissionFields) if (document.querySelector(`#desktopBridge${id}`).checked) capabilities.push(scope);
  if (capabilities.includes('desktop-control')) {
    if (!capabilities.includes('desktop-view')) throw new Error('Mouse and keyboard access also needs Screen view.');
    capabilities.push('desktop-type');
  }
  const selfManagementEnabled = document.querySelector('#desktopBridgeSelfManage').checked;
  if (grants.length === capabilities.length && grants.every(scope => capabilities.includes(scope)) &&
      selfManagementEnabled === link.selfManagementEnabled && (!activate || capabilities.every(scope => link.capabilities.includes(scope)))) {
    desktopBridgePermissionsDirty = false; desktopBridgeDraftLinkId = ''; return link;
  }
  const result = await approvedRequest(`/api/agent-links/${encodeURIComponent(linkId)}/capabilities`, {
    method: 'PATCH', body: JSON.stringify({ capabilities, selfManagementEnabled, activate, approved: true })
  }, `Save these permissions for ${link.identity?.name || 'this agent'}?`);
  state.data.agentLinks = state.data.agentLinks.map(item => item.id === linkId ? result.connection : item);
  if (state.data.settings.desktopBridge?.linkId === linkId) {
    if (link.capabilities.includes('desktop-view') && !result.connection.capabilities.includes('desktop-view')) window.HexiGridDesktopScreen?.stop?.();
    for (const [capability, kind] of [['camera-view', 'camera'], ['microphone-listen', 'microphone'], ['speaker-output', 'speaker']]) {
      if (link.capabilities.includes(capability) && !result.connection.capabilities.includes(capability)) await window.HexiGridDesktopMedia?.stop?.(kind, false);
    }
  }
  desktopBridgePermissionsDirty = false;
  desktopBridgeDraftLinkId = '';
  return result.connection;
}
document.querySelector('#desktopBridgeSavePermissions').addEventListener('click', async () => {
  if (desktopBridgePermissionsBusy) return;
  desktopBridgePermissionsBusy = true; renderDesktopBridge();
  const feedback = document.querySelector('#desktopBridgeFeedback');
  try {
    await saveDesktopLinkPermissions();
    feedback.textContent = 'Permissions saved. Start sharing when you want to use the selected camera, screen or audio access.';
  } catch (error) { feedback.textContent = error.message; }
  finally { desktopBridgePermissionsBusy = false; renderDesktopBridge(); }
});
document.querySelector('#desktopBridgeForm').addEventListener('submit', async (event) => {
  event.preventDefault(); if (desktopBridgePermissionsBusy) return;
  if (document.querySelector('#desktopBridgeLink').value === 'new') { await createDesktopLinkInvitation(event); return; }
  desktopBridgePermissionsBusy = true; renderDesktopBridge();
  const feedback = document.querySelector('#desktopBridgeFeedback'); const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; feedback.textContent = 'Starting access…';
  try {
    const select = document.querySelector('#desktopBridgeLink');
    const viewGranted = document.querySelector('#desktopBridgeView').checked;
    const controlGranted = document.querySelector('#desktopBridgeControl').checked;
    const cameraGranted = document.querySelector('#desktopBridgeCamera').checked;
    const microphoneGranted = document.querySelector('#desktopBridgeMicrophone').checked;
    const speakerGranted = document.querySelector('#desktopBridgeSpeaker').checked;
    if (!select.value) throw new Error('Choose the exact connected Hexonaut link before starting computer access.');
    if (![viewGranted, cameraGranted, microphoneGranted, speakerGranted].some(Boolean)) throw new Error('Select screen view, camera, microphone or speaker output before starting access. Use Save permissions for other changes.');
    await saveDesktopLinkPermissions({ activate: true });
    const result = await approvedRequest('/api/desktop-bridge/start', { method: 'POST', body: JSON.stringify({ linkId: select.value, viewGranted, controlGranted, textGranted: controlGranted, cameraGranted, microphoneGranted, speakerGranted, approved: true }) }, 'Start sharing for this agent with these permissions?');
    state.data.settings.desktopBridge = result.bridge;
    desktopBridgeDraftLinkId = result.bridge.linkId;
    desktopBridgeSelection = result.bridge.linkId; desktopBridgeSelectionTouched = false;
    const media = await window.HexiGridDesktopMedia.start({ camera: cameraGranted, microphone: microphoneGranted, speaker: speakerGranted, agentName: select.options[select.selectedIndex]?.textContent, request: api });
    desktopBridgePermissionsDirty = false; desktopBridgeDraftLinkId = '';
    renderDesktopBridge();
    feedback.textContent = media.failures.length ? `Computer access is on. ${media.failures.join(' ')}` : 'Computer access is on.';
  }
  catch (error) { feedback.textContent = error.message; }
  finally { desktopBridgePermissionsBusy = false; renderDesktopBridge(); }
});
document.querySelector('#tailnetLinkToggle').addEventListener('click', async () => {
  const tailnet = state.network?.tailnet || {};
  const button = document.querySelector('#tailnetLinkToggle'); button.disabled = true;
  try {
    const result = await approvedRequest('/api/network/tailnet', { method: tailnet.running ? 'DELETE' : 'POST', body: JSON.stringify({ approved: true }) }, tailnet.running ? 'Close the private Tailnet route to HexiGrid?' : 'Open HexiGrid only inside this private Tailscale tailnet?');
    state.network = { ...(state.network || {}), tailnet: result.tailnet }; renderTailnetLink();
    document.querySelector('#desktopBridgeFeedback').textContent = result.tailnet.running ? 'Private Tailnet link is ready.' : 'Private Tailnet link closed.';
  } catch (error) { document.querySelector('#desktopBridgeFeedback').textContent = error.message; renderTailnetLink(); }
  finally { button.disabled = false; }
});
document.querySelector('#tailnetLinkCopy').addEventListener('click', async () => {
  const url = state.network?.tailnet?.url; if (!url) return;
  try { await navigator.clipboard.writeText(url); document.querySelector('#desktopBridgeFeedback').textContent = 'Private Tailnet address copied.'; }
  catch { await modalRequest({ title: 'Private Tailnet address', message: url, accept: 'Done' }); }
});
document.querySelector('#agentRelayProvider').addEventListener('change', (event) => {
  state.network = { ...(state.network || {}), agentRelay: { ...(state.network?.agentRelay || {}), selectedProvider: event.target.value } };
});
document.querySelector('#agentRelayToggle').addEventListener('click', async () => {
  const relay = state.network?.agentRelay || {};
  const button = document.querySelector('#agentRelayToggle'); button.disabled = true;
  const provider = document.querySelector('#agentRelayProvider').value;
  const startMessage = provider === 'cloudflare-quick-tunnel'
    ? 'Open a temporary Cloudflare Quick Tunnel for encrypted agent invitations? Its public URL can change after a restart. Owner APIs stay local.'
    : 'Open the stable public relay (Microsoft Dev Tunnel or Tailscale, with Cloudflare fallback) for encrypted agent invitations? Owner APIs stay local.';
  try {
    const result = await approvedRequest('/api/network/agent-relay', { method: relay.running ? 'DELETE' : 'POST', body: JSON.stringify(relay.running ? { approved: true } : { approved: true, provider }) }, relay.running ? 'Close the public encrypted agent relay?' : startMessage);
    state.network = { ...(state.network || {}), agentRelay: result.agentRelay }; renderAgentRelay();
    document.querySelector('#desktopBridgeFeedback').textContent = result.agentRelay.running ? 'Public encrypted relay is ready.' : 'Public agent relay closed.';
  } catch (error) { document.querySelector('#desktopBridgeFeedback').textContent = error.message; renderAgentRelay(); }
  finally { button.disabled = false; }
});
document.querySelector('#agentRelayCopy').addEventListener('click', async () => {
  const url = state.network?.agentRelay?.url; if (!url) return;
  try { await navigator.clipboard.writeText(url); document.querySelector('#desktopBridgeFeedback').textContent = 'Public relay address copied.'; }
  catch { await modalRequest({ title: 'Public relay address', message: url, accept: 'Done' }); }
});
async function createDesktopLinkInvitation(event) {
  event.preventDefault(); desktopBridgePermissionsBusy = true; renderDesktopBridge();
  const feedback = document.querySelector('#desktopBridgeFeedback'); const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true; feedback.textContent = 'Creating a public single-use invitation…';
  try {
    const capabilities = ['messages', 'status', 'receipts', 'identity'];
    for (const [id, , scope] of desktopLinkPermissionFields) if (document.querySelector(`#desktopBridge${id}`).checked) capabilities.push(scope);
    if (capabilities.includes('desktop-control')) capabilities.push('desktop-type');
    const result = await approvedRequest('/api/agent-links/invites', { method: 'POST', body: JSON.stringify({ capabilities, selfManagementEnabled: document.querySelector('#desktopBridgeSelfManage').checked, approved: true }) }, 'Create a 24-hour outbound companion invitation with these permissions?');
    const instructions = result.agentPrompt;
    if (!instructions) throw new Error('Connection instructions were not returned. Try again before sharing the invitation.');
    const copied = await copyPlainText(instructions);
    feedback.textContent = copied ? 'Connection instructions copied. Give them to your agent. It pairs once and reuses its saved connection afterward.' : 'Copy the connection instructions from the dialog.';
    await modalRequest({ title: 'Give this to your agent', message: 'The agent gets its skill, connects once and saves how to reconnect. The invitation expires in 24 hours; the saved connection remains usable until revoked.', accept: 'Done', fields: [{ label: 'Connection instructions', value: instructions, multiline: true, readonly: true, rows: 10 }] });
  } catch (error) { feedback.textContent = error.message; }
  finally { desktopBridgePermissionsBusy = false; renderDesktopBridge(); }
}
async function desktopBridgeOwnerAction(path, message) {
  const feedback = document.querySelector('#desktopBridgeFeedback');
  const linkId = document.querySelector('#desktopBridgeLink').value;
  try { const result = await api(path, { method: 'POST', body: JSON.stringify({ linkId, approved: true }) }); if ((path.endsWith('/stop') || path.endsWith('/takeover')) && state.data.settings.desktopBridge?.linkId === linkId) await window.HexiGridDesktopMedia?.stop?.('all', false); state.data.settings.desktopBridge = result.bridge; renderDesktopBridge(); feedback.textContent = message; }
  catch (error) { feedback.textContent = error.message; }
}
document.querySelector('#desktopBridgeStop').addEventListener('click', () => { void desktopBridgeOwnerAction('/api/desktop-bridge/stop', 'Computer access stopped.'); });
document.querySelector('#desktopBridgeTakeover').addEventListener('click', () => { void desktopBridgeOwnerAction('/api/desktop-bridge/takeover', 'You have control. Agent input is paused.'); });
document.querySelector('#desktopBridgeResume').addEventListener('click', () => { void desktopBridgeOwnerAction('/api/desktop-bridge/resume', 'Agent control resumed.'); });
document.querySelector('#desktopVoiceCallStart').addEventListener('click', async () => {
  const feedback = document.querySelector('#desktopBridgeFeedback');
  try {
    const result = await api('/api/desktop-bridge/voice-call/start', { method: 'POST', body: JSON.stringify({ approved: true }) });
    desktopVoiceCall = result.voiceCall; renderDesktopVoiceCall();
    feedback.textContent = 'Voice call started. Waiting for the Hexonaut to answer.';
  } catch (error) { feedback.textContent = error.message; }
});
document.querySelector('#desktopVoiceCallMute').addEventListener('click', async () => {
  const muted = desktopVoiceCall.ownerMuted !== true; const feedback = document.querySelector('#desktopBridgeFeedback');
  try {
    const result = await api('/api/desktop-bridge/voice-call/mute', { method: 'POST', body: JSON.stringify({ muted }) });
    desktopVoiceCall = result.voiceCall; window.HexiGridDesktopMedia?.setMicrophoneMuted?.(muted); window.HexiGridDesktopMedia?.setVoicePlaybackMuted?.(muted); renderDesktopVoiceCall();
    feedback.textContent = muted ? 'Call audio muted.' : 'Call audio resumed.';
  } catch (error) { feedback.textContent = error.message; }
});
document.querySelector('#desktopVoiceCallEnd').addEventListener('click', async () => {
  const feedback = document.querySelector('#desktopBridgeFeedback');
  try {
    const result = await api('/api/desktop-bridge/voice-call/end', { method: 'POST', body: JSON.stringify({}) });
    desktopVoiceCall = result.voiceCall;
    await window.HexiGridDesktopMedia?.stop?.('microphone', false); await window.HexiGridDesktopMedia?.stop?.('speaker', false);
    renderDesktopBridge();
    feedback.textContent = 'Voice call ended.';
  } catch (error) { feedback.textContent = error.message; }
});
document.querySelector('#desktopBridgeRefresh').addEventListener('click', () => { void refreshDesktopBridgeFrame(); });
document.querySelector('#desktopBridgeStatusRefresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await refresh(); } finally { button.disabled = false; }
});
document.querySelector('#desktopBridgeLink').addEventListener('change', (event) => { desktopBridgeSelection = event.currentTarget.value; desktopBridgeSelectionTouched = true; renderDesktopBridge(); });
document.querySelector('#desktopTranscriptionSave').addEventListener('click', async (event) => {
  const linkId = document.querySelector('#desktopBridgeLink').value; const status = document.querySelector('#desktopTranscriptionStatus');
  if (!linkId) { status.textContent = 'Choose a connected Hexonaut first.'; return; }
  const button = event.currentTarget; button.disabled = true;
  try {
    const enabled = document.querySelector('#desktopTranscriptionEnabled').checked;
    const result = await approvedRequest(`/api/agent-links/${encodeURIComponent(linkId)}/transcription`, { method: 'POST', body: JSON.stringify({ enabled, memoryOnly: document.querySelector('#desktopTranscriptionMemoryOnly').checked, model: document.querySelector('#desktopTranscriptionModel').value, language: document.querySelector('#desktopTranscriptionLanguage').value.trim() || 'en', approved: true }) }, `${enabled ? 'Enable' : 'Disable'} local microphone transcription for this Hexonaut?`);
    const connection = (state.data.agentLinks || []).find((item) => item.id === linkId); if (connection) connection.transcription = result.transcription;
    renderDesktopBridge();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#desktopBridgeRemoveLink').addEventListener('click', async () => {
  const linkId = document.querySelector('#desktopBridgeLink').value;
  const connection = (state.data?.agentLinks || []).find((item) => item.id === linkId);
  if (!connection) return;
  const accepted = await modalRequest({
    title: 'Remove this connection?',
    message: `This immediately revokes ${connection.identity?.name || 'this Hexonaut'}’s link, stops its computer session, and removes this saved connection from the list. The Hexonaut profile stays available until you remove it from Agents.`,
    accept: 'Remove connection',
    danger: true
  });
  if (!accepted) return;
  const button = document.querySelector('#desktopBridgeRemoveLink');
  const feedback = document.querySelector('#desktopBridgeFeedback');
  button.disabled = true;
  try {
    await approvedRequest(`/api/agent-links/${encodeURIComponent(linkId)}`, { method: 'DELETE', body: JSON.stringify({ purge: true, approved: true }) }, 'Revoke and remove this connection?');
    desktopBridgeSelection = '';
    desktopBridgeSelectionTouched = true;
    desktopBridgeDraftLinkId = '';
    desktopBridgeDraft = { view: true, control: false, camera: false, microphone: false, speaker: false };
    await refresh();
    document.querySelector('#desktopBridgeFeedback').textContent = `${connection.identity?.name || 'Connection'} removed.`;
  } catch (error) {
    feedback.textContent = error.message;
    button.disabled = false;
  }
});
for (const [id, key] of [...desktopLinkPermissionFields, ['SelfManage', 'selfManage']]) {
  document.querySelector(`#desktopBridge${id}`).addEventListener('change', (event) => {
    const input = event.currentTarget;
    desktopBridgeDraft[key] = input.checked;
    desktopBridgePermissionsDirty = true;
    if (key === 'control' && input.checked) {
      desktopBridgeDraft.view = true;
      document.querySelector('#desktopBridgeView').checked = true;
    }
    if (key === 'view' && !input.checked) {
      desktopBridgeDraft.control = false;
      document.querySelector('#desktopBridgeControl').checked = false;
    }
    document.querySelector('#desktopBridgeFeedback').textContent = 'Unsaved permissions. Save permissions, or Start sharing to save and use them.';
  });
}
document.querySelector('#desktopBridgeSpeakerEnable').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; try { await window.HexiGridDesktopMedia?.enableSpeaker?.(); } finally { button.disabled = false; } });
window.addEventListener('hexigrid-desktop-media', (event) => {
  renderDesktopSpeakerState(event.detail || {});
});
document.querySelector('#addMemory').addEventListener('click', async () => {
  if (!state.editingAgentId) return;
  const content = document.querySelector('#memoryContent').value.trim(); if (!content) return;
  try { await api(`/api/agents/${state.editingAgentId}/memories`, { method: 'POST', body: JSON.stringify({ category: document.querySelector('#memoryCategory').value, importance: Number(document.querySelector('#memoryImportance').value), content, valid_while: document.querySelector('#memoryValidWhile').value, verify_by: document.querySelector('#memoryVerifyBy').value, evidence_excerpt: document.querySelector('#memoryEvidenceExcerpt').value }) }); document.querySelector('#memoryContent').value = ''; document.querySelector('#memoryValidWhile').value = ''; document.querySelector('#memoryVerifyBy').value = ''; document.querySelector('#memoryEvidenceExcerpt').value = ''; await refresh(); renderAgentMemories(); }
  catch (error) { notify(error.message, true); }
});

function describeInspectedMemoryFact(item) {
  return [
    `${item.id} · ${item.status} · ${item.verification || 'unverified'}${item.stale ? ' · STALE' : ''}`,
    item.text, item.warning || '',
    item.valid_while ? `Valid while: ${item.valid_while}` : '',
    item.valid_from ? `Valid from: ${item.valid_from}` : '',
    item.valid_until ? `Valid until: ${item.valid_until}` : '',
    item.verify_by ? `Recheck by: ${item.verify_by}` : '',
    `Source evidence: ${item.evidence_excerpt || 'No excerpt retained.'}`,
    item.updatedAt ? `Updated: ${item.updatedAt}` : ''
  ].filter(Boolean).join('\n');
}

document.querySelector('#inspectMemoryFact').addEventListener('click', async (event) => {
  const agentId = state.editingAgentId;
  const factId = document.querySelector('#inspectMemoryFactId').value.trim().toLowerCase();
  if (!agentId || !/^memory-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(factId)) { notify('Enter an exact dated memory ID.', true); return; }
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  try {
    // Explicit owner inspection opts into evidence; ordinary recall keeps its selected depth.
    const read = async (id) => (await api(`/api/agents/${encodeURIComponent(agentId)}/memory-facts/${encodeURIComponent(id)}?depth=2`)).memory;
    const fact = await read(factId);
    const links = fact.conflicts || [];
    const relatedIds = [...new Set(links.map((link) => link.otherId))];
    const previewIds = relatedIds.slice(0, 3);
    const related = await Promise.allSettled(previewIds.map(read));
    const previews = related.map((result, i) => result.status === 'fulfilled'
      ? describeInspectedMemoryFact(result.value)
      : `${previewIds[i]}\nLinked fact could not be read. Retry this exact ID; the inspected fact remains available.`);
    const linkDetails = links.slice(0, 20).map((link) =>
      `${link.relation} · ${link.fromId} → ${link.toId}\nReason: ${link.why || 'No reason retained.'}\nConflict evidence (${link.evidence?.kind || 'unknown source'}): ${link.evidence?.text || 'No excerpt retained.'}`);
    const omitted = relatedIds.length - previewIds.length;
    await modalRequest({ title: 'Dated fact and linked conflicts',
      message: `${links.length} recorded link(s). ${previewIds.length} linked fact preview(s) shown.${omitted ? ` ${omitted} more linked fact(s): inspect their exact IDs below separately.` : ''} Reading does not resolve a conflict or certify either fact.`,
      accept: 'Done', fields: [
        { label: 'Fact and linked previews', value: [describeInspectedMemoryFact(fact), ...previews].join('\n\n---\n\n'), multiline: true, readonly: true },
        { label: 'Conflict links and evidence', value: linkDetails.join('\n\n') || 'No conflict links recorded.', multiline: true, readonly: true },
        ...(links.length > 20 ? [{ label: 'More links', value: `${links.length - 20} links omitted from this bounded view. Use the local fact read API at depth 2 for the complete link history.`, readonly: true }] : [])
      ] });
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector('#addMemoryEntity').addEventListener('click', async () => {
  const agentId = state.editingAgentId;
  if (!agentId) return;
  const values = await modalRequest({ title: 'Add a confirmed entity?',
    message: 'Review the exact name, aliases, and project scope. Confirmed aliases can expand recall within that scope.',
    accept: 'Confirm entity', fields: [
      { label: 'Canonical name', required: true },
      { label: 'Type', options: ['person', 'project'] },
      { label: 'Project ID (optional; blank means all projects)' },
      { label: 'Aliases (comma separated; optional)' },
      { label: 'Why is this entity confirmed?', required: true }
    ] });
  if (!values) return;
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}/memory-entities`, { method: 'POST', body: JSON.stringify({
      operation: 'create', label: values[0].trim(), entityType: values[1],
      ...(values[2].trim() ? { projectId: values[2].trim() } : {}),
      aliases: values[3].split(',').map((alias) => alias.trim()).filter(Boolean), why: values[4].trim(), approved: true
    }) });
    await loadAgentMemoryEntities(agentId);
  } catch (error) { notify(error.message, true); }
});

document.querySelector('#moreMemoryEntities').addEventListener('click', () => {
  if (state.editingAgentId && memoryEntityCursor) void loadAgentMemoryEntities(state.editingAgentId, { more: true });
});
document.querySelector('#loadMemoryMetrics').addEventListener('click', () => { void loadMemoryMetrics(); });
document.querySelector('#moreMemoryMetrics').addEventListener('click', () => { void loadMemoryMetrics({ more: true }); });

document.querySelector('#runnerProfileForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const feedback = document.querySelector('#runnerFeedback'); feedback.textContent = 'Creating isolated connection…';
  try { await api('/api/ilands/profiles', { method: 'POST', body: JSON.stringify({ label: document.querySelector('#runnerLabel').value, harness: document.querySelector('#runnerHarness').value }) }); document.querySelector('#runnerLabel').value = ''; await refresh(); feedback.textContent = 'Connection created. Check the harness, then connect the account.'; }
  catch (error) { feedback.textContent = error.message; }
});

document.querySelector('#runnerInstall').addEventListener('click', async () => {
  if (!isHostBrowser()) return notify('Prepare Runner setup on the computer running HexiGrid.', true);
  const feedback = document.querySelector('#runnerFeedback'); const harness = document.querySelector('#runnerHarness').value; feedback.textContent = 'Verifying the live iLands guide and this computer…';
  try {
    if (!['setup', 'goal', 'build'].includes(state.data?.settings?.workMode)) {
      const switchMode = await modalRequest({ title: 'Switch to Connect mode?', message: 'Checking the official setup guide needs network-read permission. Connect mode allows that check while keeping unrelated actions gated.', accept: 'Switch & continue' });
      if (!switchMode) { feedback.textContent = 'Setup cancelled. Nothing changed.'; return; }
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ workMode: 'setup' }) });
      await refresh();
    }
    const reviewed = await approvedRequest('/api/ilands/install/plan', { method: 'POST', body: JSON.stringify({ harness }) }, 'Allow HexiGrid to read the official iLands setup guide and verify the release for this computer?');
    const plan = reviewed.plan;
    const accepted = await modalRequest({ title: 'Verified iLands setup handoff', message: `Official release: ${plan.release}\nPlatform: ${plan.platformKey}\nHarness: ${plan.harness}\nGuide fingerprint: ${plan.guideDigest}\n\nHexiGrid will not download or execute an installer. The next step creates a one-time instruction for the official interactive iLands flow.`, accept: 'Create handoff', danger: true });
    if (!accepted) { feedback.textContent = 'Setup handoff cancelled. Nothing was installed.'; return; }
    const result = await approvedRequest('/api/ilands/install', { method: 'POST', body: JSON.stringify({ planId: plan.id, guideDigest: plan.guideDigest, harness: plan.harness }) }, 'Create the reviewed iLands setup handoff? Installation still requires the official interactive approval flow.');
    const copy = await modalRequest({ title: 'Continue in your local agent', message: `${result.message}\n\n${result.instruction}`, accept: 'Copy instruction' });
    if (copy) { const copied = await copyPlainText(result.instruction); feedback.textContent = copied ? 'Setup instruction copied. Paste it into the selected local agent.' : 'Copy was blocked by this browser. Select the instruction in the dialog and copy it manually.'; }
    else feedback.textContent = 'The verified setup handoff is ready. Run it when you are ready to connect this account.';
  } catch (error) { feedback.textContent = error.message; }
});

document.querySelector('#authRecover').addEventListener('click', async () => {
  const answer = await modalRequest({ title: 'Recover this workspace', message: 'Recovery works only on the host computer. It revokes every earlier signed-in session.', accept: 'Reset passcode', danger: true, fields: [{ label: 'Recovery code', required: true }, { label: 'New passcode (10+ characters)', type: 'password', required: true }] });
  if (!answer) return;
  try { const result = await api('/api/auth/recover', { method: 'POST', body: JSON.stringify({ recoveryCode: answer[0], password: answer[1] }) }); await modalRequest({ title: 'Passcode reset', message: `Save the replacement recovery code:\n\n${result.recoveryCode}`, accept: 'I saved it' }); window.hideAuthGate?.(); await refresh(); }
  catch (error) { document.querySelector('#authFeedback').textContent = error.message; }
});

document.querySelector('#mcpForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!isHostBrowser()) return notify('Add MCP servers on the computer running HexiGrid.', true);
  const transport = document.querySelector('#mcpTransport').value; const secretName = document.querySelector('#mcpSecretName').value.trim();
  const request = { name: document.querySelector('#mcpName').value, transport, image: document.querySelector('#mcpImage').value, command: document.querySelector('#mcpCommand').value, args: document.querySelector('#mcpArgs').value, workspaceAccess: document.querySelector('#mcpWorkspaceAccess').value, url: document.querySelector('#mcpUrl').value, secrets: secretName ? { [transport === 'http' ? 'bearer' : secretName]: document.querySelector('#mcpSecretValue').value } : {} };
  try { await approvedRequest('/api/mcp', { method: 'POST', body: JSON.stringify(request) }, 'Starting a new MCP program can run software on this computer. Add it disabled?'); event.target.reset(); syncMcpTransportFields(); document.querySelector('#mcpFeedback').textContent = 'Server added disabled. Check it to discover real tools.'; await refresh(); }
  catch (error) { document.querySelector('#mcpFeedback').textContent = error.message; }
});

document.querySelector('#imageForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const feedback = document.querySelector('#imageFeedback'); feedback.textContent = 'Generating…';
  const request = { providerId: document.querySelector('#imageProvider').value, model: document.querySelector('#imageModel').value, prompt: document.querySelector('#imagePrompt').value, size: document.querySelector('#imageSize').value };
  try { await approvedRequest('/api/media/images', { method: 'POST', body: JSON.stringify(request) }, 'Approve this image generation once?'); document.querySelector('#imagePrompt').value = ''; feedback.textContent = 'Image saved locally.'; await refresh(); }
  catch (error) { feedback.textContent = error.message; }
});

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-view="integrations"]')) { hexispaceLinkCacheAt = 0; setTimeout(() => void renderHexiSpaceLinks(true), 0); }
  if (event.target.closest('#refreshHexiSpaceLinks')) { hexispaceLinkCacheAt = 0; await renderHexiSpaceLinks(true); return; }
  const hexispaceLinkButton = event.target.closest('[data-hexispace-link-revoke]');
  if (hexispaceLinkButton) {
    const cleanupOnly = Number(hexispaceLinkButton.dataset.pendingCleanup) > 0;
    const accepted = await modalRequest({ title: cleanupOnly ? 'Retry mailbox cleanup?' : 'Revoke this HexiSpace connection?', message: cleanupOnly ? 'The browser link is already inactive. HexiGrid will retry removing the mailbox credentials that were attached to it.' : 'HexiSpace will immediately lose the permissions granted by this link. Any attached mailbox credentials will also be removed from this computer’s credential vault.', accept: cleanupOnly ? 'Retry cleanup' : 'Revoke connection', danger: true });
    if (!accepted) return;
    try {
      const result = await api('/api/hexispace/v1/link/revoke', { method: 'POST', body: JSON.stringify({ linkId: hexispaceLinkButton.dataset.hexispaceLinkRevoke }) });
      hexispaceLinkCache = null; hexispaceLinkCacheAt = 0;
      const feedback = document.querySelector('#hexispaceLinksFeedback');
      if (feedback) feedback.textContent = result.mailboxCleanupPending ? 'Access is revoked, but one or more mailbox credentials remain inaccessible in the vault. Retry cleanup after the vault is available.' : 'HexiSpace access was revoked.';
      await renderHexiSpaceLinks(true);
    } catch (error) { const feedback = document.querySelector('#hexispaceLinksFeedback'); if (feedback) feedback.textContent = error.message; }
    return;
  }
  const entityButton = event.target.closest('[data-entity-action]');
  if (entityButton) {
    const agentId = state.editingAgentId;
    const entity = agentMemoryEntities.find((item) => item.id === entityButton.dataset.entityId);
    if (!agentId || !entity) return;
    const operation = entityButton.dataset.entityAction;
    if (operation === 'history') {
      try {
        let after = 0;
        while (true) {
          const page = await api(`/api/agents/${encodeURIComponent(agentId)}/memory-entities/${encodeURIComponent(entity.id)}/history?limit=50&after=${after}`);
          const events = page.events || [];
          const proceed = await modalRequest({ title: `History for ${entity.label}`,
            message: 'Append-only changes and their owner reasons. Memory fact text is separate.',
            accept: page.hasMore ? 'Next page' : 'Done', fields: [{ label: 'Changes', multiline: true, readonly: true,
              value: events.map((item) => `${item.createdAt || item.at || 'unknown time'} · ${item.action} · ${item.by || 'unknown'} · ${item.why || 'no reason'}`).join('\n') || 'No changes recorded.' }] });
          if (!proceed || !page.hasMore) break;
          after = page.nextCursor;
        }
      } catch (error) { notify(error.message, true); }
      return;
    }
    let body = { operation, entityId: entity.id, expectedRevision: entity.revision, approved: true };
    if (operation === 'confirm') {
      const values = await modalRequest({ title: 'Confirm this suggested entity?',
        message: 'Check that this name really identifies this person or project. Pending names cannot expand recall until confirmed.',
        accept: 'Confirm name', fields: [
          { label: 'Name found in memory', value: entity.label, readonly: true },
          { label: 'Type', options: ['person', 'project'], value: entity.entityType },
          { label: 'Project scope', value: entity.projectId || 'All projects', readonly: true },
          { label: 'Aliases (comma separated; optional)' },
          { label: 'Why is this name confirmed?', required: true }
        ] });
      if (!values) return;
      body = { ...body, label: entity.label, entityType: values[1], aliases: values[3].split(',').map((alias) => alias.trim()).filter(Boolean), why: values[4].trim() };
    } else if (operation === 'reject') {
      const values = await modalRequest({ title: 'Reject this suggested name?', message: entity.label,
        accept: 'Reject name', fields: [{ label: 'Why is this name rejected?', required: true }] });
      if (!values) return;
      body.why = values[0].trim();
    } else if (operation === 'alias-add') {
      const values = await modalRequest({ title: 'Add an alias?',
        message: `This name will refer to ${entity.label} only within its approved scope.`,
        accept: 'Add alias', fields: [{ label: 'Exact alias', required: true }, { label: 'Why does this alias refer to the entity?', required: true }] });
      if (!values) return;
      body.alias = values[0].trim();
      body.why = values[1].trim();
    } else if (operation === 'alias-remove') {
      body.alias = entityButton.dataset.entityAlias;
      const values = await modalRequest({ title: 'Remove this alias?', message: `${body.alias} will stop expanding to ${entity.label}.`,
        accept: 'Remove alias', fields: [{ label: 'Why remove this alias?', required: true }] });
      if (!values) return;
      body.why = values[0].trim();
    } else return;
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/memory-entities`, { method: 'POST', body: JSON.stringify(body) });
      await loadAgentMemoryEntities(agentId);
    } catch (error) { notify(error.message, true); }
    return;
  }
  const proposalApprove = event.target.closest('[data-memory-proposal-approve]');
  const proposalReject = event.target.closest('[data-memory-proposal-reject]');
  if (proposalApprove || proposalReject) {
    const proposalId = proposalApprove?.dataset.memoryProposalApprove || proposalReject?.dataset.memoryProposalReject;
    const proposal = pendingMemoryProposals.find((item) => item.id === proposalId && item.agentId === state.editingAgentId);
    if (!proposal) return;
    const action = proposalApprove ? 'approve' : 'reject';
    if (action === 'approve' && (proposal.kind === 'risk-quarantine' || proposal.quarantined === true)) {
      notify('Quarantined candidates cannot be approved or recalled.', true);
      return;
    }
    const currentOwnerNote = proposal.kind === 'owner-memory-correction'
      ? (state.data?.memories || []).find((item) => item.id === proposal.payload?.memoryId && item.agentId === proposal.agentId)
      : null;
    const fields = action === 'approve' ? [
      ...(proposal.kind === 'owner-memory-correction' ? [{ label: 'Current exact owner note', value: currentOwnerNote?.content || 'No longer available', multiline: true, readonly: true }] : []),
      { label: 'Proposed exact text', value: proposal.payload?.text || '', multiline: true, readonly: true },
      { label: 'Validity condition', value: proposal.payload?.valid_while || '', readonly: true },
      { label: 'Recheck by', value: proposal.payload?.verify_by || '', readonly: true },
      { label: 'Source evidence excerpt', value: proposal.payload?.evidence_excerpt || '', multiline: true, readonly: true },
      { label: 'Reason and expected next behavior', value: [proposal.payload?.why, proposal.payload?.expectedNextBehavior].filter(Boolean).join('\n'), multiline: true, readonly: true },
      { label: 'Recorded source message (agent assertion; verify independently)', value: proposal.payload?.source?.text || '', multiline: true, readonly: true }
    ] : [{ label: 'Why reject this proposal?', required: true }];
    const decision = await modalRequest({ title: action === 'approve' ? 'Commit this reviewed memory?' : 'Reject this memory proposal?',
      message: action === 'approve' ? 'Approval writes an exact dated fact or correction for this agent as unverified. Check the text and source before committing.' : 'The proposal will stay out of current memory.',
      accept: action === 'approve' ? 'Commit memory' : 'Reject proposal', danger: action === 'approve', fields });
    if (!decision) return;
    try {
      const result = await api(`/api/memory-proposals/${encodeURIComponent(proposalId)}/decision`, { method: 'POST', body: JSON.stringify({ decision: action, ...(action === 'reject' ? { reason: decision[0] } : {}) }) });
      if (action === 'approve' && proposal.kind !== 'owner-memory-correction' && result.status === 'approved' && result.memoryId && Number.isInteger(result.revision)) {
        const confirmation = await modalRequest({ title: 'Review and confirm the committed revision?',
          message: 'The dated memory is stored as unverified. Confirm this exact revision only after checking its source; you can leave it unverified.',
          accept: 'Confirm source', fields: [
            { label: 'Committed exact text', value: proposal.payload?.text || '', multiline: true, readonly: true },
            { label: 'Source', value: proposal.kind === 'correction'
              ? [proposal.payload?.source?.kind, proposal.payload?.source?.id, proposal.payload?.source?.createdAt, proposal.payload?.source?.text].filter(Boolean).join('\n')
              : `Agent proposal via Link ${proposal.linkId || 'unknown'} at ${proposal.createdAt || 'unknown time'}`, multiline: true, readonly: true },
            { label: 'Validity condition', value: proposal.payload?.valid_while || '', readonly: true },
            { label: 'Source evidence excerpt', value: proposal.payload?.evidence_excerpt || '', multiline: true, readonly: true },
            { label: 'Committed revision', value: String(result.revision), readonly: true },
            { label: 'Why is this source confirmed?', required: true }
          ] });
        if (confirmation) {
          try {
            await api(`/api/agents/${encodeURIComponent(proposal.agentId)}/memory-commit`, { method: 'POST', body: JSON.stringify({ operation: 'confirm', id: result.memoryId, expectedRevision: result.revision, why: confirmation[5], approved: true }) });
          } catch (error) { notify(`Memory remains unverified. Confirmation failed: ${error.message}`, true); }
        }
      }
      await refresh(); await loadAgentMemoryProposals(state.editingAgentId); renderAgentMemories();
    } catch (error) { notify(error.message, true); }
    return;
  }
  const confirmMemoryButton = event.target.closest('[data-memory-confirm]');
  if (confirmMemoryButton) {
    const memory = (state.data?.memories || []).find((item) => item.id === confirmMemoryButton.dataset.memoryConfirm && item.agentId === state.editingAgentId);
    if (!memory || memory.verification === 'owner-confirmed') return;
    const values = await modalRequest({ title: 'Review and confirm this note?',
      message: 'Confirm only after checking the exact note and its source. This review changes verification state without editing the note.',
      accept: 'Confirm source', fields: [
        { label: 'Exact note', value: memory.content, multiline: true, readonly: true },
        { label: 'Source', value: memory.source || 'unknown', readonly: true },
        { label: 'Validity condition', value: memory.valid_while || '', readonly: true },
        { label: 'Recheck by', value: memory.verify_by || '', readonly: true },
        { label: 'Source evidence excerpt', value: memory.evidence_excerpt || '', multiline: true, readonly: true },
        { label: 'Last updated', value: memory.updatedAt || memory.createdAt || 'unknown', readonly: true },
        { label: 'Why is this source confirmed?', required: true }
      ] });
    if (!values) return;
    try {
      await api(`/api/memories/${encodeURIComponent(memory.id)}/confirm`, { method: 'POST', body: JSON.stringify({ expectedRevision: memory.revisions?.length || 0, why: values.at(-1), approved: true }) });
      await refresh(); renderAgentMemories();
    } catch (error) { notify(error.message, true); }
    return;
  }
  const editMemoryButton = event.target.closest('[data-memory-edit]');
  if (editMemoryButton) {
    const memory = (state.data?.memories || []).find((item) => item.id === editMemoryButton.dataset.memoryEdit);
    if (!memory) return;
    const values = await modalRequest({ title: 'Revise memory', message: 'The previous standing and wording remain in its revision history. Changing the text marks the note unverified until reviewed again.', accept: 'Save revision', fields: [
      { label: 'Text', value: memory.content, multiline: true, required: true },
      { label: 'Category', value: memory.category, required: true },
      { label: 'Importance', options: ['1', '2', '3', '4', '5'], value: String(memory.importance) },
      { label: 'Standing', options: ['active', 'conditional', 'superseded', 'disputed', 'rejected', 'historical'], value: memory.status || 'active' },
      { label: 'Valid while', value: memory.valid_while || '' },
      { label: 'Recheck by (YYYY-MM-DD)', value: memory.verify_by || '' },
      { label: 'Source evidence excerpt', value: memory.evidence_excerpt || '', multiline: true },
      { label: 'Why is this changing?', required: true }
    ] });
    if (!values) return;
    try { await api(`/api/memories/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ content: values[0], category: values[1], importance: Number(values[2]), status: values[3], valid_while: values[4], verify_by: values[5], evidence_excerpt: values[6], reason: values[7], expectedRevision: memory.revisions?.length || 0 }) }); await refresh(); renderAgentMemories(); }
    catch (error) { notify(error.message, true); }
    return;
  }
  const memoryButton = event.target.closest('[data-memory-remove]');
  if (memoryButton) { const memory = (state.data?.memories || []).find((item) => item.id === memoryButton.dataset.memoryRemove); if (!memory) return; const accepted = await modalRequest({ title: 'Retire this owner note?', message: 'The note stops being used in current recall. History stays local. You can restore it by editing its standing.', accept: 'Retire note' }); if (!accepted) return; try { await api(`/api/memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: memory.revisions?.length || 0 }) }); await refresh(); renderAgentMemories(); } catch (error) { notify(error.message, true); } return; }
  const sessionButton = event.target.closest('[data-session-revoke]');
  if (sessionButton) { const accepted = await modalRequest({ title: 'Revoke this session?', message: 'That browser will need the local passcode before it can access HexiGrid again.', accept: 'Revoke session', danger: true }); if (!accepted) return; try { await api(`/api/auth/sessions/${sessionButton.dataset.sessionRevoke}`, { method: 'DELETE' }); if (sessionRecords.find((item) => item.id === sessionButton.dataset.sessionRevoke)?.current) location.reload(); else await loadSessions(); } catch (error) { notify(error.message, true); } return; }
  const runnerButton = event.target.closest('[data-runner-action]');
  if (runnerButton) {
    const action = runnerButton.dataset.runnerAction; const profileId = runnerButton.dataset.runnerId;
    try {
      if (action === 'remove') { const accepted = await modalRequest({ title: 'Remove this connection?', message: 'Dashboard metadata is removed. Runner credentials are preserved so accidental removal is recoverable.', accept: 'Remove connection', danger: true }); if (!accepted) return; await approvedRequest(`/api/ilands/profiles/${profileId}`, { method: 'DELETE', body: '{}' }, 'Approve removing this connection metadata?'); }
      else await approvedRequest(`/api/ilands/profiles/${profileId}/${action}`, { method: 'POST', body: '{}' }, action === 'bind' ? 'This opens iLands browser authorization for the selected account.' : `Approve ${action} for this Runner?`);
      await refresh();
    } catch (error) { document.querySelector('#runnerFeedback').textContent = error.message; }
    return;
  }
  const mcpButton = event.target.closest('[data-mcp-action]');
  if (mcpButton) {
    const id = mcpButton.dataset.mcpId; const action = mcpButton.dataset.mcpAction;
    try {
      if (action === 'test') await approvedRequest(`/api/mcp/${id}/test`, { method: 'POST', body: '{}' }, 'Start this server briefly and discover the tools it reports?');
      if (action === 'toggle') {
        const enabled = mcpButton.dataset.mcpEnabled === 'true'; const server = state.data.mcpServers.find((item) => item.id === id); let toolGrants = {};
        if (enabled) {
          const fields = server.tools.flatMap((tool) => { const grant = server.toolGrants?.[tool.name] || { capability: 'run_tools', risk: 'high' }; return [
            { label: `${tool.name}: capability`, options: ['read_local', 'network_read', 'write_workspace', 'run_tools', 'external_write', 'generate_media'], value: grant.capability, description: tool.description || 'No description provided.' },
            { label: `${tool.name}: risk`, options: ['low', 'medium', 'high', 'critical'], value: grant.risk },
            { label: `I reviewed ${tool.name}`, type: 'checkbox', value: false }
          ]; });
          const answer = await modalRequest({ title: 'Review every MCP tool', message: `The server identity and ${server.tools.length} tool manifest${server.tools.length === 1 ? '' : 's'} are pinned. Assign only what each tool truly needs. A changed executable, server identity, schema, or tool list will disable the connection.`, accept: 'Enable reviewed tools', danger: true, fields });
          if (!answer) return;
          server.tools.forEach((tool, index) => { toolGrants[tool.name] = { capability: answer[index * 3], risk: answer[index * 3 + 1], approved: answer[index * 3 + 2] === true }; });
        }
        await approvedRequest(`/api/mcp/${id}/enable`, { method: 'PATCH', body: JSON.stringify({ enabled, toolGrants, expectedToolSetDigest: server.toolSetDigest }) }, enabled ? 'Enable these exact reviewed MCP capabilities?' : 'Disable this MCP server?');
      }
      if (action === 'credentials') {
        const server = state.data.mcpServers.find(item => item.id === id);
        const answer = await modalRequest({ title: 'Update protected MCP credentials', message: 'Replace all saved credentials with the one below, or clear them. This disables the server until you discover and review its tools again. Values stay in this device OS vault.', accept: 'Update credentials', danger: true, fields: [
          { label: 'Protected name', value: server.transport === 'http' ? 'bearer' : '', description: 'For web servers use bearer. Container servers use the required environment variable name.' },
          { label: 'Protected value', type: 'password' },
          { label: 'Clear all saved credentials', type: 'checkbox', value: false }
        ] });
        if (!answer) return;
        if (!answer[2] && (!answer[0].trim() || !answer[1])) throw Error('Enter a protected name and value, or choose Clear all saved credentials.');
        const secrets = answer[2] ? {} : { [answer[0].trim()]: answer[1] };
        await approvedRequest(`/api/mcp/${id}/secrets`, { method: 'PUT', body: JSON.stringify({ secrets }) }, 'Update protected credentials and disable this server for review?');
      }
      if (action === 'remove') { const accepted = await modalRequest({ title: 'Remove this MCP server?', message: 'Its configuration and protected credential will be deleted from this device.', accept: 'Remove server', danger: true }); if (!accepted) return; await approvedRequest(`/api/mcp/${id}`, { method: 'DELETE', body: '{}' }, 'Approve removal once?'); }
      await refresh();
    } catch (error) { await refresh().catch(() => {}); notify(error.message, true); }
    return;
  }
  const toolButton = event.target.closest('[data-mcp-use]');
  if (toolButton) {
    const server = state.data.mcpServers.find((item) => item.id === toolButton.dataset.mcpUse); const tool = server?.tools.find((item) => item.name === toolButton.dataset.mcpTool); if (!tool) return;
    const properties = tool.inputSchema?.properties || {}; const required = new Set(tool.inputSchema?.required || []);
    const fields = Object.entries(properties).slice(0, 30).map(([name, schema]) => ({ label: schema.title || name, placeholder: schema.description || '', required: required.has(name), multiline: schema.type === 'object' || schema.type === 'array', value: schema.default === undefined ? '' : typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default) }));
    try {
      const values = await modalRequest({ title: tool.name, message: tool.description || `Run a tool from ${server.name}.`, accept: 'Review & run', fields }); if (!values) return;
      const input = {}; Object.keys(properties).slice(0, 30).forEach((name, index) => { const schema = properties[name]; const value = values[index]; if (!value && !required.has(name)) return; if (schema.type === 'number' || schema.type === 'integer') input[name] = Number(value); else if (schema.type === 'boolean') input[name] = /^(true|yes|1)$/i.test(value); else if (schema.type === 'object' || schema.type === 'array') { try { input[name] = JSON.parse(value); } catch { throw new Error(`${name} needs valid JSON.`); } } else input[name] = value; });
      const result = await approvedRequest(`/api/mcp/${server.id}/call`, { method: 'POST', body: JSON.stringify({ tool: tool.name, input }) }, `Run ${tool.name} through ${server.name}?`); const output = JSON.stringify(result.result, null, 2).slice(0, 12000); await modalRequest({ title: `${tool.name} completed`, message: output, accept: 'Done' }); await refresh();
    } catch (error) { notify(error.message, true); }
  }
});

window.HexiGridOpenAgentInvitation = () => {
  desktopBridgeSelection = 'new'; desktopBridgeSelectionTouched = true;
  desktopBridgePermissionsDirty = false; desktopBridgeDraftLinkId = '';
  renderDesktopBridge();
  document.querySelector('#desktopBridgeForm')?.scrollIntoView({behavior: 'smooth', block: 'start'});
};

window.HexiGridManageAgentAccess = linkId => {
  desktopBridgeSelection = linkId; desktopBridgeSelectionTouched = true;
  desktopBridgePermissionsDirty = false; desktopBridgeDraftLinkId = '';
  renderDesktopBridge(); document.querySelector('#desktopBridgeForm')?.scrollIntoView({behavior: 'smooth', block: 'start'});
};
