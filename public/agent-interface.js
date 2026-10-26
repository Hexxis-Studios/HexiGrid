(() => {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
  const records = (items, render) => `<div class="records">${items.length ? items.map(render).join('') : '<p>No records.</p>'}</div>`;
  const providerNeedsKey = (provider) => {
    try { return ['opencode.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'router.huggingface.co'].includes(new URL(provider.baseUrl).hostname.toLowerCase()); }
    catch { return false; }
  };
  const agentLabel = (item, agents) => agents.filter((candidate) => String(candidate.name).trim().toLowerCase() === String(item.name).trim().toLowerCase()).length > 1 ? `${item.name} · ${String(item.id).slice(-6)}` : item.name;
  function rosterStanding(item, state) {
    const link = rosterLink(item, state);
    if (link || ['ilands-link', 'agent-link'].includes(item.transport)) {
      return link ? window.HexiGridViewRenderers.linkPresence(link).label : 'No active link';
    }
    return item.status === 'local_ready' ? 'Local ready' : item.status || 'Unknown';
  }
  function rosterLink(item, state) {
    return connectedLinks(state).filter(candidate => candidate.agentId === item.id)
      .sort((a, b) => (Date.parse(b.connectedAt || 0) || 0) - (Date.parse(a.connectedAt || 0) || 0))[0] || null;
  }
  function rosterModel(item, state) {
    return rosterLink(item, state) || ['ilands-link', 'agent-link'].includes(item.transport)
      ? 'Managed in agent’s app' : item.model || 'not-configured';
  }
  const interfaceRoot = document.querySelector('#agentInterface');
  const statusRoot = document.querySelector('#agentStatus');
  const unlockPanel = document.querySelector('#agentUnlock');
  const unlockForm = document.querySelector('#agentUnlockForm');
  const passcodeInput = document.querySelector('#agentPasscode');
  const googleSignInButton = document.querySelector('#agentGoogleSignIn');
  const codexRelayForm = document.querySelector('#codexRelayForm');
  const codexDeliveryReview = window.HexiGridCodexDeliveries.attach(document.querySelector('#agentCodexDeliveries'), { request, refresh: start });
  let latestManifest = null;
  let latestState = null;
  let codexRelaySelection = '';
  let codexConversationChoices = [];
  let desktopFrameTimer = null;
  let desktopFrameBusy = false;
  let desktopBridgeSelection = '';
  let desktopBridgeSelectionTouched = false;
  let linkPermissionEditBusy = false;
  let linkPermissionEditLinkId = '';
  let linkPermissionEditScope = '';
  let linkPermissionEditChecked = false;
  let linkPermissionSelectorWasDisabled = null;
  let memoryReview;
  let memoryRecall;
  let memorySharing;
  const refreshMemoryReview = () => memoryReview.refresh();
  let desktopVoiceCall = { status: 'idle', ownerMuted: false };
  let desktopVoiceTimer = null;
  let speechDraftLink = '', speechDirty = false, speechSaving = false;
  const linkPermissions = [
    ['desktop-view', 'See my screen'], ['desktop-control', 'Use my mouse and keyboard'], ['desktop-type', 'Type text'],
    ['camera-view', 'See my camera'], ['microphone-listen', 'Hear my microphone'], ['speaker-output', 'Speak through my speakers'],
    ['workspace-read', 'Read HexiGrid project files'], ['workspace-write', 'Write HexiGrid project files'],
    ['memory-read', 'Read this agent’s HexiGrid memory'], ['memory-write', 'Manage this agent’s memory under this Link’s trust and policy'],
    ['tasks', 'Manage this Link’s HexiGrid tasks (current mode and approvals apply)'],
    ['owner-filesystem-read', 'Read files across my computer'], ['owner-filesystem-write', 'Write files across my computer'],
    ['owner-process', 'Run local programs and terminal commands'], ['desktop-system-keys', 'Use Windows system keys']
  ];

  function setBusy(busy) {
    interfaceRoot?.setAttribute('aria-busy', String(busy));
  }

  function revealUnlockPanel(auth = {}) {
    if (!unlockPanel) return;
    unlockPanel.hidden = false;
    const googleOnly = auth.googleLinked === true && auth.localPasscode !== true;
    if (unlockForm) unlockForm.hidden = googleOnly;
    if (googleSignInButton) googleSignInButton.hidden = auth.googleLinked !== true;
    const title = document.querySelector('#agentUnlockTitle');
    const copy = document.querySelector('#agentUnlockCopy');
    if (title) title.textContent = googleOnly ? 'Continue with Google' : 'Unlock this device';
    if (copy) copy.textContent = googleOnly
      ? 'This workspace uses your linked Google account. HexiGrid will restore the local owner session on this computer.'
      : 'Continue with the linked Google account, or use the local passcode if one has been configured.';
    if (!googleOnly) window.requestAnimationFrame(() => passcodeInput?.focus());
  }

  function csrfToken() {
    const raw = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('hexigrid_csrf='))?.slice('hexigrid_csrf='.length) || '';
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  async function request(path, options = {}) {
    if (window.HexiGridStandalone?.isActive()) return window.HexiGridStandalone.request(path, options);
    try {
      const method = String(options.method || 'GET').toUpperCase();
      const csrf = csrfToken();
      const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(method !== 'GET' && csrf ? { 'x-hexigrid-csrf': csrf } : {}), ...(options.headers || {}) } });
      const type = response.headers.get('content-type') || '';
      if (window.HexiGridStandalone?.shouldFallback(response, '', type, path, method)) { window.HexiGridStandalone.activate(); return window.HexiGridStandalone.request(path, options); }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status}).`), { status: response.status, body });
      return body;
    } catch (error) {
      if (error.status) throw error;
      if (options.signal?.aborted || error?.name === 'AbortError') throw error;
      throw Object.assign(new Error('The HexiGrid server is unavailable. Use Refresh workspace after it reconnects; this action was not retried.'), { status: 503, code: 'HOST_UNAVAILABLE' });
    }
  }

  function connectedLinks(state) {
    return window.HexiGridViewRenderers.currentAgentLinks(state);
  }

  function linkLabel(link) {
    const name = link.identity?.name || link.id;
    const connected = Date.parse(link.connectedAt || '');
    const when = Number.isFinite(connected) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(connected) : 'time unknown';
    const shortId = String(link.id || '').slice(-8) || 'unknown';
    return `${name} · ${window.HexiGridViewRenderers.linkPresence(link).label} · paired ${when} · ${shortId}`;
  }

  function renderMicrophoneState(state = {}) {
    const select = document.querySelector('#desktopBridgeMicrophoneDevice');
    const status = document.querySelector('#desktopBridgeMicrophoneStatus');
    const meter = document.querySelector('#desktopBridgeMicrophoneMeter');
    const level = document.querySelector('#desktopBridgeMicrophoneLevel');
    const levelText = document.querySelector('#desktopBridgeMicrophoneLevelText');
    const active = state.microphone === true;
    const label = state.microphoneDeviceLabel || (state.microphoneDeviceId ? 'Selected microphone' : 'System default microphone');
    if (select && state.microphoneDeviceId && [...select.options].some((option) => option.value === state.microphoneDeviceId)) select.value = state.microphoneDeviceId;
    if (status) status.textContent = active ? `Active microphone: ${label}` : 'No microphone is being shared.';
    if (meter) meter.hidden = !active;
    const currentLevel = Math.max(0, Math.min(1, Number(state.microphoneLevel) || 0));
    if (level) level.value = currentLevel;
    if (levelText) levelText.textContent = active ? `${Math.round(currentLevel * 100)}%` : 'Not active';
  }

  function renderMicrophoneDevices(devices = [], selectedId = '') {
    const select = document.querySelector('#desktopBridgeMicrophoneDevice');
    if (!select) return;
    const current = selectedId || select.value;
    select.innerHTML = `<option value="">System default microphone</option>${devices.map((device) => `<option value="${escape(device.deviceId)}">${escape(device.label)}</option>`).join('')}`;
    if ([...select.options].some((option) => option.value === current)) select.value = current;
    select.disabled = devices.length === 0;
  }

  function renderSpeakerState(state = {}) {
    const status = document.querySelector('#desktopBridgeSpeakerStatus');
    const enable = document.querySelector('#desktopBridgeSpeakerEnable');
    const granted = state.speaker === true;
    const blocked = state.speakerPlaybackBlocked === true;
    if (status) status.textContent = granted ? (blocked ? 'Agent audio is waiting for a click to enable playback.' : 'Agent audio will play through this browser session.') : 'Agent speaker output is off.';
    if (enable) {
      enable.hidden = !blocked;
      enable.disabled = false;
    }
  }

  async function refreshMicrophoneDevices() {
    try {
      const devices = await window.HexiGridDesktopMedia?.enumerateMicrophones?.() || [];
      const mediaState = window.HexiGridDesktopMedia?.state?.() || {};
      renderMicrophoneDevices(devices, mediaState.microphoneDeviceId || '');
      renderMicrophoneState(mediaState);
    } catch (error) {
      const status = document.querySelector('#desktopBridgeMicrophoneStatus');
      if (status) status.textContent = error.message || 'Microphone devices are unavailable in this browser.';
    }
  }

  async function refreshDesktopFrame() {
    if (desktopFrameBusy) return;
    const bridge = latestState?.settings?.desktopBridge || latestState?.desktopBridge;
    if (!bridge?.enabled || !bridge.viewGranted) return;
    desktopFrameBusy = true;
    try {
      const result = await request('/api/desktop-bridge/frame');
      const image = document.querySelector('#desktopBridgeFrame');
      const preview = document.querySelector('#desktopBridgePreview');
      if (image && result.frame?.data) image.src = `data:${result.frame.mimeType || 'image/png'};base64,${result.frame.data}`;
      if (preview) preview.hidden = false;
      if (latestState?.settings) latestState.settings.desktopBridge = result.bridge;
      const status = document.querySelector('#desktopBridgeStatus');
      if (status) {
        const controlState = result.bridge?.agentControlActive ? 'Agent control is active' : 'You have control';
        status.textContent = result.frame?.source === 'owner-browser' ? `${controlState} · owner browser screen` : controlState;
      }
    } catch (error) {
      const feedback = document.querySelector('#desktopBridgeFeedback');
      if (feedback) feedback.textContent = error.message;
    } finally { desktopFrameBusy = false; }
  }

  function renderVoiceCall() {
    const bridge = latestState?.settings?.desktopBridge || latestState?.desktopBridge || {};
    const media = window.HexiGridDesktopMedia?.state?.() || {};
    const live = desktopVoiceCall.linkId === bridge.linkId && ['offered', 'active'].includes(desktopVoiceCall.status);
    const linkOnline = connectedLinks(latestState || {}).some((link) => link.id === bridge.linkId && link.status === 'online');
    const status = document.querySelector('#desktopVoiceCallStatus');
    const start = document.querySelector('#desktopVoiceCallStart');
    const mute = document.querySelector('#desktopVoiceCallMute');
    const end = document.querySelector('#desktopVoiceCallEnd');
    if (status) status.textContent = desktopVoiceCall.status === 'offered' ? 'Calling… waiting for the Hexonaut to answer.' : desktopVoiceCall.status === 'ringing' ? `${desktopVoiceCall.callerName || 'Your agent'} is calling. Accept or decline in the incoming-call prompt.` : desktopVoiceCall.status === 'active' ? (desktopVoiceCall.ownerMuted ? 'Call connected · microphone muted' : 'Call connected · microphone live') : desktopVoiceCall.status === 'ended' ? 'Call ended.' : 'Start computer access with microphone and agent audio to call. Incoming calls ring here; you choose whether to answer.';
    if (start) start.disabled = !bridge.enabled || !linkOnline || !media.microphone || !media.speaker || live;
    if (mute) { mute.disabled = !live; mute.textContent = desktopVoiceCall.ownerMuted ? 'Unmute' : 'Mute'; }
    if (end) end.disabled = !live;
  }

  async function refreshVoiceCall() {
    const bridge = latestState?.settings?.desktopBridge || latestState?.desktopBridge || {};
    if (!bridge.enabled) { desktopVoiceCall = { status: 'idle', ownerMuted: false }; window.HexiGridIncomingVoiceCall?.update({ request, voiceCall: desktopVoiceCall, bridge }); renderVoiceCall(); return; }
    try { const result = await request('/api/desktop-bridge'); desktopVoiceCall = result.voiceCall || desktopVoiceCall; window.HexiGridIncomingVoiceCall?.update({ request, voiceCall: desktopVoiceCall, bridge: result.bridge || bridge, media: window.HexiGridDesktopMedia?.state?.(), transcripts: result.transcripts || [] }); renderVoiceCall(); }
    catch { /* The bridge feedback reports connection failures. */ }
  }

  function renderSpeechSettings(link) {
    const changed = speechDraftLink !== (link?.id || '');
    if (changed) { speechDraftLink = link?.id || ''; speechDirty = false; }
    const fields = ['agentSpeechEnabled', 'agentSpeechMemoryOnly', 'agentSpeechModel', 'agentSpeechLanguage'];
    for (const id of fields) { const input = document.querySelector(`#${id}`); if (input) input.disabled = !link || speechSaving; }
    const save = document.querySelector('#agentSpeechSave'); if (save) save.disabled = !link || speechSaving;
    if (speechDirty && !changed) return;
    const settings = link?.transcription || {};
    const enabled = document.querySelector('#agentSpeechEnabled'), memoryOnly = document.querySelector('#agentSpeechMemoryOnly');
    const model = document.querySelector('#agentSpeechModel'), language = document.querySelector('#agentSpeechLanguage');
    if (enabled) enabled.checked = settings.enabled === true;
    if (memoryOnly) memoryOnly.checked = settings.memoryOnly === true;
    if (model) model.value = settings.model || 'tiny';
    if (language) language.value = settings.language || 'en';
    const status = document.querySelector('#agentSpeechStatus');
    if (status) status.textContent = !link ? 'Choose a connected Link.' : settings.lastError ? `Local speech engine: ${settings.lastError}`
      : !settings.enabled ? 'Off for this Link. Microphone permission alone does not produce transcripts.'
      : settings.memoryOnly ? 'Blocked: the installed file-based engine cannot satisfy memory-only audio.'
      : `Enabled for this Link with ${settings.model || 'tiny'} (${settings.language || 'en'}). Requires active microphone sharing and an installed local engine; this setting is not a successful call test.`;
  }

  function setLinkPermissionEditBusy(busy) {
    if (linkPermissionEditBusy === busy) return false;
    const select = document.querySelector('#desktopBridgeLink');
    if (busy) {
      linkPermissionEditLinkId = select?.value || '';
      linkPermissionSelectorWasDisabled = select?.disabled ?? false;
      linkPermissionEditBusy = true;
    } else {
      linkPermissionEditBusy = false;
      if (select && linkPermissionSelectorWasDisabled !== null) select.disabled = linkPermissionSelectorWasDisabled;
    }
    if (latestState) renderLinkPermissionControls(latestState, select,
      connectedLinks(latestState).find((link) => link.id === (linkPermissionEditBusy ? linkPermissionEditLinkId : (select?.value || (latestState.settings.desktopBridge || latestState.desktopBridge || {}).linkId))));
    if (!busy) {
      linkPermissionEditLinkId = '';
      linkPermissionEditScope = '';
      linkPermissionSelectorWasDisabled = null;
    }
    return true;
  }

  function renderLinkPermissionControls(state, select, selectedLink) {
    if (select && linkPermissionEditBusy) select.disabled = true;
    const doorScopes = linkPermissions.slice(0, 8).map(([scope]) => scope);
    const selectedScopes = selectedLink?.capabilities || [];
    const ownerGrantedScopes = selectedLink?.grantedCapabilities || selectedScopes;
    const permissions = document.querySelector('#desktopLinkPermissions');
    if (permissions) permissions.innerHTML = linkPermissions.map(([scope, label]) => `<label><input type="checkbox" data-link-permission="${scope}" ${(linkPermissionEditBusy && scope === linkPermissionEditScope ? linkPermissionEditChecked : ownerGrantedScopes.includes(scope)) ? 'checked' : ''} ${linkPermissionEditBusy || !selectedLink || (scope.startsWith('owner-') || scope === 'desktop-system-keys') && selectedLink.trustLevel !== 'owner' ? 'disabled' : ''} /> ${escape(label)}${ownerGrantedScopes.includes(scope) && !selectedScopes.includes(scope) ? ' (paused by agent)' : ''}</label>`).join('');
    const grantDoor = document.querySelector('#desktopBridgeGrant');
    if (grantDoor) grantDoor.disabled = linkPermissionEditBusy || !selectedLink || doorScopes.every((scope) => ownerGrantedScopes.includes(scope));
    const revokeDoor = document.querySelector('#desktopBridgeRevoke');
    if (revokeDoor) revokeDoor.disabled = linkPermissionEditBusy || !selectedLink || !doorScopes.some((scope) => ownerGrantedScopes.includes(scope));
    const doorStatus = document.querySelector('#desktopDoorAccessStatus');
    if (doorStatus) doorStatus.textContent = selectedLink ? `Computer/project scopes granted: ${doorScopes.filter((scope) => ownerGrantedScopes.includes(scope)).length} of ${doorScopes.length} · active: ${doorScopes.filter((scope) => selectedScopes.includes(scope)).length} · ${selectedLink.trustLevel === 'owner' ? 'owner-agent machine tools available within trust' : 'project text files only'}.` : 'Select the exact paired link to review its computer and project scopes.';
    const ownerGrant = document.querySelector('#ownerAgentGrant');
    const ownerRevoke = document.querySelector('#ownerAgentRevoke');
    if (ownerGrant) ownerGrant.disabled = linkPermissionEditBusy || !selectedLink || selectedLink.trustLevel === 'owner';
    if (ownerRevoke) ownerRevoke.disabled = linkPermissionEditBusy || !selectedLink || selectedLink.trustLevel !== 'owner';
    const ownerStatus = document.querySelector('#ownerAgentStatus');
    if (ownerStatus) ownerStatus.textContent = selectedLink?.trustLevel === 'owner'
      ? 'Owner-agent trust is granted to this exact Link. Machine files and local processes use the current Windows account and remain subject to work mode, approval profile, and the active computer session.'
      : 'Scoped access is the default. Owner-agent trust requires an explicit grant to this exact Link.';
  }

  function renderDesktopBridge(state) {
    const bridge = state.settings.desktopBridge || state.desktopBridge || {};
    const select = document.querySelector('#desktopBridgeLink');
    if (select) {
      const pendingLinkId = select.value;
      select.innerHTML = `<option value="">Choose a connected link</option>${connectedLinks(state).map((link) => `<option value="${escape(link.id)}">${escape(linkLabel(link))}</option>`).join('')}`;
      const selectedLinkId = linkPermissionEditBusy ? linkPermissionEditLinkId : desktopBridgeSelectionTouched ? desktopBridgeSelection : (bridge.linkId || desktopBridgeSelection || pendingLinkId);
      select.value = connectedLinks(state).some((link) => link.id === selectedLinkId) ? selectedLinkId : '';
      if (!desktopBridgeSelectionTouched && select.value) desktopBridgeSelection = select.value;
    }
    const selectedLink = connectedLinks(state).find((link) => link.id === (select?.value || bridge.linkId));
    renderSpeechSettings(selectedLink);
    const bridgeLive = bridge.enabled && bridge.linkId === selectedLink?.id;
    const selectedScopes = selectedLink?.capabilities || [];
    renderLinkPermissionControls(state, select, selectedLink);
    const startButton = document.querySelector('#desktopBridgeForm button[type="submit"]');
    if (startButton) { startButton.disabled = !selectedScopes.some(scope => ['desktop-view', 'camera-view', 'microphone-listen', 'speaker-output'].includes(scope)); startButton.title = startButton.disabled ? 'Choose a paired agent with a screen or media permission.' : ''; }
    const view = document.querySelector('#desktopBridgeView'); if (view) { view.checked = bridgeLive ? bridge.viewGranted === true : selectedScopes.includes('desktop-view'); view.disabled = !selectedScopes.includes('desktop-view'); }
    const control = document.querySelector('#desktopBridgeControl'); if (control) control.checked = bridge.controlGranted === true;
    const text = document.querySelector('#desktopBridgeText'); if (text) text.checked = bridge.textGranted === true;
    if (bridge.enabled) {
      const active = window.HexiGridDesktopMedia?.active?.() || {};
      const camera = document.querySelector('#desktopBridgeCamera'); if (camera) camera.checked = active.camera === true;
      const microphone = document.querySelector('#desktopBridgeMicrophone'); if (microphone) microphone.checked = active.microphone === true;
      const speaker = document.querySelector('#desktopBridgeSpeaker'); if (speaker) speaker.checked = active.speaker === true;
      renderMicrophoneState(active);
      renderSpeakerState(active);
    }
    if (!bridge.enabled) {
      const active = window.HexiGridDesktopMedia?.state?.() || {};
      renderMicrophoneState(active);
      renderSpeakerState(active);
    }
    const preview = document.querySelector('#desktopBridgePreview'); if (preview) preview.hidden = !bridgeLive || !bridge.viewGranted || !selectedScopes.includes('desktop-view');
    const status = document.querySelector('#desktopBridgeStatus'); if (status) status.textContent = bridge.enabled && !bridgeLive ? 'Another agent has the current session. Start access to switch to the selected agent.' : bridgeLive ? (bridge.agentControlActive ? 'Agent control is active' : 'Selected sharing permissions are active') : (bridge.message || 'Computer access is off.');
    const stop = document.querySelector('#desktopBridgeStop'); if (stop) stop.disabled = !bridge.enabled;
    const takeover = document.querySelector('#desktopBridgeTakeover'); if (takeover) takeover.disabled = !bridgeLive || !bridge.agentControlActive;
    const resume = document.querySelector('#desktopBridgeResume'); if (resume) resume.disabled = !bridgeLive || !bridge.controlGranted || bridge.agentControlActive;
    renderVoiceCall();
    if (desktopFrameTimer) { clearInterval(desktopFrameTimer); desktopFrameTimer = null; }
    if (bridgeLive && bridge.viewGranted && selectedScopes.includes('desktop-view')) { desktopFrameTimer = setInterval(refreshDesktopFrame, 3000); void refreshDesktopFrame(); }
    if (desktopVoiceTimer) { clearInterval(desktopVoiceTimer); desktopVoiceTimer = null; }
    if (bridgeLive) { desktopVoiceTimer = setInterval(refreshVoiceCall, 2000); void refreshVoiceCall(); }
  }

  function renderActionCatalog() {
    if (!latestManifest) return;
    const query = document.querySelector('#agentActionSearch').value;
    const authentication = document.querySelector('#agentActionAuthentication').value;
    const entries = window.HexiGridViewRenderers.agentCatalogEntries(latestManifest, { query, authentication });
    const total = window.HexiGridViewRenderers.agentCatalogEntries(latestManifest).length;
    document.querySelector('#agentActionCount').textContent = `${entries.length} of ${total} endpoints`;
    const labels = { signed: 'Signed Link', owner: 'Owner session', workspace: 'Workspace session' };
    const needle = query.trim().toLowerCase();
    document.querySelector('#agentActions').innerHTML = entries.map(({ name, kind, action, path, authentication: auth }) => {
      const guides = needle ? Object.values(action).filter(value => value && typeof value === 'object' &&
        typeof value.tool === 'string' && value.tool.toLowerCase().includes(needle)) : [];
      const focused = guides.map(({ tool, note, ...contract }) => `<div class="action-tool-guide">
        <h3>${escape(tool)}</h3><p>${escape(note || '')}</p>
        <pre aria-label="Tool contract for ${escape(tool)}">${escape(JSON.stringify({ tool,
          requiredCapabilities: action.capabilitiesByTool?.[tool] || [], ...contract }, null, 2))}</pre>
      </div>`).join('');
      const full = `<p>${escape(action.description || action.note || '')}</p>
        <pre aria-label="Request contract for ${escape(name)}">${escape(JSON.stringify(action, null, 2))}</pre>`;
      return `<details class="action-record" data-${kind === 'actions' ? 'action' : 'resource'}-name="${escape(name)}" ${needle ? 'open' : ''}>
      <summary><strong>${escape(name)}</strong><span class="action-auth">${labels[auth]}</span><code>${escape(action.method)} ${escape(path)}</code></summary>
      ${focused}${guides.length ? `<details class="action-full-contract"><summary>Full endpoint contract</summary>${full}</details>` : full}
    </details>`;
    }).join('') || '<p>No endpoints match. Try a shorter search or choose all sessions.</p>';
  }

  function renderUsageSnapshot() {
    if (!latestState) return;
    const days = Number(document.querySelector('#agentUsagePeriod').value);
    const report = window.HexiGridViewRenderers.agentUsageReport(latestState, { days });
    document.querySelector('#agentUsageSummary').textContent = `${report.requests} recorded requests · ${report.inputTokens.toLocaleString()} input + ${report.outputTokens.toLocaleString()} output = ${(report.inputTokens + report.outputTokens).toLocaleString()} tokens · ${report.metering}`;
    document.querySelector('#agentUsageRows').innerHTML = records(report.agents, row => `<article class="record"><strong>${escape(row.name)}</strong><code>${escape(row.agentId)}</code><small>${row.requests} requests · ${row.inputTokens.toLocaleString()} input · ${row.outputTokens.toLocaleString()} output · ${escape(row.metering)}</small></article>`);
    document.querySelector('#agentUsageJson').textContent = JSON.stringify(report, null, 2);
  }

  function renderCodexRelaySettings(state) {
    const relay = state.settings.codexRelay || {};
    const links = connectedLinks(state);
    const selected = links.some(link => link.id === codexRelaySelection) ? codexRelaySelection : links.some(link => link.id === relay.linkId) ? relay.linkId : links[0]?.id || '';
    codexRelaySelection = selected;
    const route = relay.linkId === selected ? relay : (relay.routes || []).find(item => item.linkId === selected) || {};
    const linkSelect = document.querySelector('#codexRelayLink');
    if (linkSelect) {
      linkSelect.innerHTML = `<option value="">Choose an agent</option>${links.map(link => `<option value="${escape(link.id)}">${escape(linkLabel(link))}</option>`).join('')}`;
      linkSelect.value = selected;
    }
    const threadInput = document.querySelector('#codexRelayThread'); if (threadInput) threadInput.value = route.threadId || '';
    const approvedSelect = document.querySelector('#codexApprovedChats');
    if (approvedSelect) {
      const saved = [{ threadId: route.threadId, title: route.threadTitle || route.threadId }, ...(route.approvedChats || [])].filter(chat => chat.threadId);
      const choices = [...new Map([...saved.map(chat => ({ id: chat.threadId, title: chat.title })), ...codexConversationChoices].map(chat => [chat.id, chat])).values()];
      approvedSelect.innerHTML = choices.map(chat => `<label><input type="checkbox" value="${escape(chat.id)}" data-chat-title="${escape(chat.title)}" ${chat.id === route.threadId ? 'disabled title="Default conversation"' : ''} ${saved.some(item => item.threadId === chat.id) ? 'checked' : ''} /> ${escape(chat.title)}</label>`).join('');
      if (threadInput) { threadInput.innerHTML = `<option value="">Choose a conversation</option>${choices.map(chat => `<option value="${escape(chat.id)}">${escape(chat.title)}</option>`).join('')}`; threadInput.value = route.threadId || ''; }
    }
    const repliesInput = document.querySelector('#codexRelayReplies'); if (repliesInput) repliesInput.checked = route.forwardReplies !== false;
    const namedInput = document.querySelector('#codexRelayNamedThreads');
    if (namedInput) { namedInput.checked = route.allowNamedThreads === true; namedInput.disabled = links.find(link => link.id === selected)?.trustLevel !== 'owner'; }
    const enabledInput = document.querySelector('#codexRelayEnabled'); if (enabledInput) enabledInput.checked = route.enabled === true;
    const feedback = document.querySelector('#codexRelayFeedback'); if (feedback) feedback.textContent = route.enabled ? 'Messages enabled for this agent.' : 'Messages disabled for this agent.';
  }

  document.querySelector('#loadCodexConversations')?.addEventListener('click', async event => {
    const feedback = document.querySelector('#codexRelayFeedback'); event.target.disabled = true;
    try {
      const result = await request('/api/codex-chats?linkId=' + encodeURIComponent(codexRelaySelection));
      codexConversationChoices = result.chats || [];
      renderCodexRelaySettings(latestState);
      feedback.textContent = 'Choose the conversations this agent may message, then save.';
    } catch (error) { feedback.textContent = error.message; }
    finally { event.target.disabled = false; }
  });

  document.querySelector('#codexRelayLink')?.addEventListener('change', event => {
    codexRelaySelection = event.target.value;
    if (latestState) renderCodexRelaySettings(latestState);
  });

  function render(manifest, state) {
    document.querySelector('#memory-recall').hidden = false;
    latestManifest = manifest;
    latestState = state;
    codexDeliveryReview.render(state.codexDeliveries || []);
    document.querySelector('#agentUnlock').hidden = true;
    const links = connectedLinks(state);
    const bridge = state.settings.desktopBridge || state.desktopBridge || {};
    const activeLink = links.find((link) => link.id === bridge.linkId);
    const online = links.filter((link) => (link.heartbeat?.state || link.status) === 'online').length;
    document.querySelector('#agentStatus').classList.remove('error');
    const presence = window.HexiGridViewRenderers.linkPresence(activeLink || {});
    const sessionLabel = !bridge.enabled ? 'Off' : !activeLink ? 'No authorized Link' : presence.state !== 'online' ? `Enabled · ${presence.label.toLowerCase()}` : bridge.agentControlActive ? 'Agent control active' : 'Session active · owner control';
    const checkedAt = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date());
    document.querySelector('#agentStatus').innerHTML = `<h2>Workspace connected</h2><dl class="workspace-snapshot"><div><dt>Session</dt><dd>${state.security?.standaloneBrowser ? 'Browser vault' : 'Signed-in owner'}</dd></div><div><dt>Agent Links</dt><dd>${links.length} paired · ${online} online</dd></div><div><dt>Computer session</dt><dd>${escape(sessionLabel)}</dd></div><div><dt>Work mode</dt><dd><code>${escape(state.settings.workMode)}</code></dd></div></dl><small>Checked ${escape(checkedAt)} · use Refresh workspace for current status. A paired Link can make signed requests while its heartbeat is idle; live access still depends on current grants, policy and session switches.</small>${activeLink ? `<p class="connection-contact">${escape(presence.detail)}</p>` : ''}<small>Interface ${escape(manifest.schemaVersion)} · app ${escape(manifest.appVersion)}.</small>`;
    document.querySelector('#agentRules').innerHTML = manifest.operatingRules.map((rule) => `<li>${escape(rule)}</li>`).join('');
    document.querySelector('#agentPolicy').innerHTML = `<div><dt>Work mode</dt><dd><code>${escape(state.settings.workMode)}</code></dd></div><div><dt>Approval profile</dt><dd><code>${escape(state.settings.approvalPolicy)}</code></dd></div><div><dt>Default model</dt><dd><code>${escape(state.settings.model || 'not-configured')}</code></dd></div><div><dt>Secret values exposed</dt><dd>No</dd></div>`;
    renderCodexRelaySettings(state);
    renderDesktopBridge(state);
    document.querySelector('#agentProviders').innerHTML = records(state.providers || [], (provider) => `<article class="record" data-provider-id="${escape(provider.id)}"><strong>${escape(provider.name)}</strong><small>${escape(provider.kind || (provider.local ? 'local' : 'cloud'))} · ${provider.modelIds?.length || 0} models · ${provider.hasKey ? 'key configured' : providerNeedsKey(provider) ? 'key required before chat' : 'no key required'}</small></article>`);
    document.querySelector('#agentRoster').innerHTML = records(window.HexiGridViewRenderers.orderAgents(state.agents || [], state.agentLinks || []), (agent) => `<article class="record" data-agent-id="${escape(agent.id)}"><strong>${escape(agentLabel(agent, state.agents || []))}</strong><small>model <code>${escape(rosterModel(agent, state))}</code> · ${escape(rosterStanding(agent, state))}</small></article>`);
    const workRecords=window.HexiGridViewRenderers.agentWorkRecords(state);
    document.querySelector('#agentRooms').innerHTML=workRecords.rooms;
    document.querySelector('#agentTasks').innerHTML=workRecords.tasks;
    renderUsageSnapshot();
    document.querySelector('#agentReceipts').innerHTML = records((state.receipts || []).slice(0, 20), (receipt) => `<article class="record" data-receipt-id="${escape(receipt.id)}"><strong>${escape(receipt.status || 'unknown')} · ${escape(receipt.action)}</strong><small>${escape(receipt.detail)}</small><code>${escape(receipt.id || 'ID not recorded')}</code><small>Permission: ${escape(receipt.capability || 'not recorded')} · Agent: ${escape(receipt.agentId || 'not recorded')}</small></article>`);
    renderActionCatalog();
    window.HexiGridWakeWordUI?.sync?.({ request, state });
  }

  async function start() {
    setBusy(true);
    try {
      let auth = await request('/api/auth/status');
      if (!auth.authenticated && auth.googleLinked && window.HexiGridGoogle) {
        await window.HexiGridGoogle.prepare();
        const idToken = await window.HexiGridGoogle.idToken();
        if (idToken) await request('/api/auth/google/firebase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) });
        auth = await request('/api/auth/status');
      }
      if (!auth.authenticated) {
        document.querySelector('#memory-recall').hidden = true;
        statusRoot?.classList.add('error');
        if (statusRoot) statusRoot.innerHTML = `<h2>Sign in required</h2><p>${escape(auth.googleLinked ? 'Continue with the linked Google account to restore your owner session.' : 'Unlock this tab to use your HexiGrid workspace.')}</p>`;
        revealUnlockPanel(auth);
        return;
      }
      const [manifest, state] = await Promise.all([request('/api/agent-interface'), request('/api/bootstrap')]);
      render(manifest, state);
      await refreshMemoryReview();
      await memorySharing.refresh();
      await memoryRecall.refresh();
    } catch (error) {
      document.querySelector('#memory-recall').hidden = true;
      statusRoot?.classList.add('error');
      if (statusRoot) statusRoot.innerHTML = `<h2>${error.status === 503 ? 'Workspace disconnected' : 'Locked'}</h2><p>${escape(error.status === 401 ? 'Unlock this tab to use your HexiGrid workspace.' : error.message)}</p>`;
      const auth = await request('/api/auth/status').catch(() => ({}));
      if (auth.authenticated === false) revealUnlockPanel(auth);
    } finally {
      setBusy(false);
    }
  }

  memoryReview = window.HexiGridViewRenderers.createMemoryReview({ root: document.querySelector('#memory-review'), request, agents: () => latestState?.agents || [] });
  memoryRecall = window.HexiGridViewRenderers.createMemoryRecall({ root: document.querySelector('#memory-recall'), request,
    healthReports: () => latestState?.memoryLearning?.maintenance || [],
    agents: () => window.HexiGridViewRenderers.orderAgents(latestState?.agents || [], latestState?.agentLinks || []),
    label: agent => agentLabel(agent, latestState?.agents || []), openProfile() {}, ask: window.HexiGridModal.create() });
  memorySharing = window.HexiGridMemorySharing.create({ root: document.querySelector('#memory-sharing'), request, agents: () => latestState?.agents || [], links: () => latestState?.agentLinks || [] });
  document.querySelector('#agentActionSearch').addEventListener('input', renderActionCatalog);
  document.querySelector('#agentActionAuthentication').addEventListener('change', renderActionCatalog);
  document.querySelector('#agentWorkspaceRefresh').addEventListener('click', () => { void start(); });
  document.querySelector('#agentUsagePeriod').addEventListener('change', renderUsageSnapshot);

  googleSignInButton?.addEventListener('click', async () => {
    const feedback = document.querySelector('#agentUnlockFeedback');
    googleSignInButton.disabled = true;
    if (feedback) feedback.textContent = 'Restoring the linked Google session…';
    try {
      if (!window.HexiGridGoogle) throw new Error('Google sign-in did not load. Check the internet connection and reload HexiGrid.');
      await window.HexiGridGoogle.connect();
      const idToken = await window.HexiGridGoogle.idToken();
      if (!idToken) throw new Error('Google did not return a sign-in token. Choose Continue with Google again.');
      await request('/api/auth/google/firebase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) });
      statusRoot?.classList.remove('error');
      if (feedback) feedback.textContent = '';
      await start();
    } catch (error) {
      if (feedback) feedback.textContent = error.message;
    } finally { googleSignInButton.disabled = false; }
  });

  document.querySelector('#agentUnlockForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#agentUnlockFeedback');
    const button = form.querySelector('button');
    form.setAttribute('aria-busy', 'true');
    button.disabled = true;
    feedback.textContent = 'Unlocking locally…';
    try {
      await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: passcodeInput.value }) });
      passcodeInput.value = '';
      statusRoot?.classList.remove('error');
      await start();
      feedback.textContent = '';
    } catch (error) { feedback.textContent = error.message; }
    finally { form.removeAttribute('aria-busy'); button.disabled = false; }
  });

  codexRelayForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const feedback = document.querySelector('#codexRelayFeedback');
    const button = codexRelayForm.querySelector('button[type="submit"]');
    button.disabled = true; feedback.textContent = 'Saving locally…';
    try {
      const threadId = document.querySelector('#codexManualThread').value.trim() || document.querySelector('#codexRelayThread').value;
      const body = { codexRelay: {
        enabled: document.querySelector('#codexRelayEnabled').checked,
        linkId: document.querySelector('#codexRelayLink').value,
        threadId,
        threadTitle: codexConversationChoices.find(chat => chat.id === threadId)?.title || '',
        approvedChats: Array.from(document.querySelectorAll('#codexApprovedChats input:checked')).map(option => ({ threadId: option.value, title: option.dataset.chatTitle })),
        forwardReplies: document.querySelector('#codexRelayReplies').checked,
        allowNamedThreads: document.querySelector('#codexRelayNamedThreads').checked
      } };
      const result = await request('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      latestState = { ...latestState, settings: result.settings };
      render(latestManifest, latestState);
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  });

  document.querySelector('#desktopBridgeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const feedback = document.querySelector('#desktopBridgeFeedback'); const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true; feedback.textContent = 'Starting computer access…';
    let screenCaptureWarning = '';
    try {
      const select = document.querySelector('#desktopBridgeLink');
      const viewGranted = document.querySelector('#desktopBridgeView').checked;
      const cameraGranted = document.querySelector('#desktopBridgeCamera').checked;
      const microphoneGranted = document.querySelector('#desktopBridgeMicrophone').checked;
      const speakerGranted = document.querySelector('#desktopBridgeSpeaker').checked;
      const microphoneDeviceId = document.querySelector('#desktopBridgeMicrophoneDevice').value;
      if (!select.value) throw new Error('Choose the exact connected Hexonaut link before starting computer access.');
      const result = await request('/api/desktop-bridge/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: select.value, viewGranted, controlGranted: document.querySelector('#desktopBridgeControl').checked, textGranted: document.querySelector('#desktopBridgeText').checked, cameraGranted, microphoneGranted, speakerGranted, approved: true }) });
      latestState.settings.desktopBridge = result.bridge;
      desktopBridgeSelection = result.bridge.linkId;
      desktopBridgeSelectionTouched = false;
      if (viewGranted && window.HexiGridDesktopScreen?.start) {
        void window.HexiGridDesktopScreen.start({ request }).catch((error) => {
          screenCaptureWarning = error.message || 'Browser screen sharing was not granted; native capture will be attempted.';
          const captureFeedback = document.querySelector('#desktopBridgeFeedback');
          if (captureFeedback) captureFeedback.textContent = `Computer access is on. ${screenCaptureWarning}`;
        });
      }
      const media = await window.HexiGridDesktopMedia.start({ camera: cameraGranted, microphone: microphoneGranted, speaker: speakerGranted, microphoneDeviceId, agentName: select.options[select.selectedIndex]?.textContent, request });
      render(latestManifest, latestState);
      const notes = [screenCaptureWarning, ...media.failures].filter(Boolean);
      feedback.textContent = notes.length ? `Computer access is on. ${notes.join(' ')}` : 'Computer access is on.';
    } catch (error) {
      window.HexiGridDesktopScreen?.stop?.();
      feedback.textContent = error.message;
    }
    finally { button.disabled = false; }
  });

  async function desktopAction(path, message) {
    const feedback = document.querySelector('#desktopBridgeFeedback');
    try { const result = await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: true }) }); if (path.endsWith('/stop')) { window.HexiGridDesktopScreen?.stop?.(); await window.HexiGridDesktopMedia?.stop?.('all', false); } else if (path.endsWith('/takeover')) await window.HexiGridDesktopMedia?.stop?.('all', false); latestState.settings.desktopBridge = result.bridge; render(latestManifest, latestState); feedback.textContent = message; }
    catch (error) { feedback.textContent = error.message; }
  }
  document.querySelector('#desktopBridgeStop')?.addEventListener('click', () => { void desktopAction('/api/desktop-bridge/stop', 'Computer access stopped.'); });
  document.querySelector('#desktopBridgeTakeover')?.addEventListener('click', () => { void desktopAction('/api/desktop-bridge/takeover', 'You have control. Agent input is paused.'); });
  document.querySelector('#desktopBridgeResume')?.addEventListener('click', () => { void desktopAction('/api/desktop-bridge/resume', 'Agent control resumed.'); });
  document.querySelector('#desktopVoiceCallStart')?.addEventListener('click', async () => {
    const feedback = document.querySelector('#desktopBridgeFeedback');
    try { const result = await request('/api/desktop-bridge/voice-call/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); desktopVoiceCall = result.voiceCall; renderVoiceCall(); feedback.textContent = 'Voice call started. Waiting for the Hexonaut to answer.'; }
    catch (error) { feedback.textContent = error.message; }
  });
  document.querySelector('#desktopVoiceCallMute')?.addEventListener('click', async () => {
    const muted = desktopVoiceCall.ownerMuted !== true; const feedback = document.querySelector('#desktopBridgeFeedback');
    try { const result = await request('/api/desktop-bridge/voice-call/mute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ muted }) }); desktopVoiceCall = result.voiceCall; window.HexiGridDesktopMedia?.setMicrophoneMuted?.(muted); window.HexiGridDesktopMedia?.setVoicePlaybackMuted?.(muted); renderVoiceCall(); feedback.textContent = muted ? 'Call audio muted.' : 'Call audio resumed.'; }
    catch (error) { feedback.textContent = error.message; }
  });
  document.querySelector('#desktopVoiceCallEnd')?.addEventListener('click', async () => {
    const feedback = document.querySelector('#desktopBridgeFeedback');
    try { const result = await request('/api/desktop-bridge/voice-call/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); desktopVoiceCall = result.voiceCall; await window.HexiGridDesktopMedia?.stop?.('microphone', false); await window.HexiGridDesktopMedia?.stop?.('speaker', false); renderVoiceCall(); feedback.textContent = 'Voice call ended.'; }
    catch (error) { feedback.textContent = error.message; }
  });
  document.querySelector('#desktopBridgeRefresh')?.addEventListener('click', () => { void refreshDesktopFrame(); });
  window.addEventListener('hexigrid-desktop-screen', (event) => {
    const detail = event.detail || {};
    if (detail.lastError) {
      const feedback = document.querySelector('#desktopBridgeFeedback');
      if (feedback) feedback.textContent = detail.lastError;
    }
  });
  window.addEventListener('hexigrid-desktop-media', (event) => { renderMicrophoneState(event.detail || {}); renderSpeakerState(event.detail || {}); });
  document.querySelector('#desktopBridgeSpeakerEnable')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await window.HexiGridDesktopMedia?.enableSpeaker?.(); }
    finally { button.disabled = false; }
  });
  document.querySelector('#desktopBridgeLink')?.addEventListener('change', (event) => {
    if (linkPermissionEditBusy) { event.currentTarget.value = linkPermissionEditLinkId; return; }
    desktopBridgeSelection = event.currentTarget.value;
    desktopBridgeSelectionTouched = true;
    if (latestManifest && latestState) render(latestManifest, latestState);
  });
  document.querySelector('#agentSpeechSettings')?.addEventListener('input', () => { speechDirty = true; });
  document.querySelector('#agentSpeechSave')?.addEventListener('click', async () => {
    if (speechSaving) return;
    const linkId = document.querySelector('#desktopBridgeLink')?.value;
    const link = connectedLinks(latestState || {}).find(item => item.id === linkId);
    const status = document.querySelector('#agentSpeechStatus');
    if (!link) { if (status) status.textContent = 'Choose the exact connected Link first.'; return; }
    const input = { enabled: document.querySelector('#agentSpeechEnabled').checked, memoryOnly: document.querySelector('#agentSpeechMemoryOnly').checked,
      model: document.querySelector('#agentSpeechModel').value, language: document.querySelector('#agentSpeechLanguage').value.trim() || 'en' };
    speechSaving = true; renderSpeechSettings(link);
    try {
      const result = await request(`/api/agent-links/${encodeURIComponent(linkId)}/transcription`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      if (result.connection?.id !== linkId || !result.transcription) throw new Error('Speech settings receipt did not match the selected Link. Refresh before retrying.');
      const stored = connectedLinks(latestState || {}).find(item => item.id === linkId); if (stored) stored.transcription = result.transcription;
      if (speechDraftLink === linkId) speechDirty = false;
    } catch (error) {
      if (speechDraftLink === linkId) { speechDirty = true; if (status) status.textContent = error.body?.approvalRequired ? 'Speech settings need owner approval. The draft is retained; use the human interface approval flow.' : error.message; }
    } finally {
      speechSaving = false; renderSpeechSettings(connectedLinks(latestState || {}).find(item => item.id === document.querySelector('#desktopBridgeLink')?.value));
    }
  });
  async function updateDoorScopes(grant) {
    if (linkPermissionEditBusy) return;
    const feedback = document.querySelector('#desktopBridgeFeedback');
    const linkId = document.querySelector('#desktopBridgeLink')?.value;
    const link = connectedLinks(latestState || {}).find((item) => item.id === linkId);
    if (!link) { feedback.textContent = 'Choose the exact connected agent link first.'; return; }
    const doorScopes = linkPermissions.slice(0, 8).map(([scope]) => scope);
    const grants = link.grantedCapabilities || link.capabilities || [];
    const capabilities = grant
      ? [...new Set([...grants, ...doorScopes])]
      : grants.filter((scope) => !doorScopes.includes(scope));
    if (!setLinkPermissionEditBusy(true)) return;
    try {
      const result = await request(`/api/agent-links/${encodeURIComponent(link.id)}/capabilities`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities, approved: true }) });
      latestState.agentLinks = (latestState.agentLinks || []).map((item) => item.id === result.connection.id ? result.connection : item);
      render(latestManifest, latestState);
      if (!grant && latestState.settings.desktopBridge?.linkId === link.id) { window.HexiGridDesktopScreen?.stop?.(); await window.HexiGridDesktopMedia?.stop?.('all', false); }
      feedback.textContent = grant ? 'Computer and HexiGrid project permissions granted to the selected Link.' : 'Computer and project permissions revoked. Other active owner-agent permissions remain available.';
    } catch (error) { feedback.textContent = error.message; }
    finally { setLinkPermissionEditBusy(false); }
  }
  document.querySelector('#desktopBridgeGrant')?.addEventListener('click', () => { void updateDoorScopes(true); });
  document.querySelector('#desktopBridgeRevoke')?.addEventListener('click', () => { void updateDoorScopes(false); });
  for (const [id, kind] of [['desktopBridgeCamera', 'camera'], ['desktopBridgeMicrophone', 'microphone'], ['desktopBridgeSpeaker', 'speaker']]) {
    document.querySelector(`#${id}`)?.addEventListener('change', async (event) => {
      const bridge = latestState?.settings?.desktopBridge;
      if (!bridge?.enabled) return;
      const input = event.currentTarget;
      const enabled = input.checked;
      const feedback = document.querySelector('#desktopBridgeFeedback');
      const link = connectedLinks(latestState || {}).find((item) => item.id === bridge.linkId);
      input.disabled = true;
      try {
        await window.HexiGridDesktopMedia.setKind(kind, enabled, {
          request,
          microphoneDeviceId: document.querySelector('#desktopBridgeMicrophoneDevice')?.value || '',
          agentName: link?.identity?.name || 'connected Hexonaut'
        });
        render(latestManifest, latestState);
        feedback.textContent = `${kind} ${enabled ? 'on' : 'off'} for this session.`;
      } catch (error) { input.checked = !enabled; feedback.textContent = error.message; }
      finally { input.disabled = false; }
    });
  }
  document.querySelector('#desktopLinkPermissions')?.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-link-permission]');
    if (!input) return;
    const scope = input.dataset.linkPermission;
    if (!linkPermissions.some(([item]) => item === scope)) return;
    const linkId = linkPermissionEditBusy ? linkPermissionEditLinkId : document.querySelector('#desktopBridgeLink')?.value;
    const link = connectedLinks(latestState || {}).find((item) => item.id === linkId);
    const grants = link?.grantedCapabilities || link?.capabilities || [];
    if (linkPermissionEditBusy) { input.checked = grants.includes(scope); return; }
    if (!link) return;
    const feedback = document.querySelector('#desktopBridgeFeedback');
    const checked = input.checked;
    linkPermissionEditScope = scope;
    linkPermissionEditChecked = checked;
    if (!setLinkPermissionEditBusy(true)) { input.checked = grants.includes(scope); return; }
    const capabilities = checked ? [...new Set([...grants, scope])] : grants.filter((item) => item !== scope);
    try {
      const result = await request(`/api/agent-links/${encodeURIComponent(link.id)}/capabilities`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities, approved: true }) });
      latestState.agentLinks = (latestState.agentLinks || []).map((item) => item.id === result.connection.id ? result.connection : item);
      if (!checked && latestState.settings.desktopBridge?.linkId === link.id) {
        if (scope === 'desktop-view') window.HexiGridDesktopScreen?.stop?.();
        const mediaKind = { 'camera-view': 'camera', 'microphone-listen': 'microphone', 'speaker-output': 'speaker' }[scope];
        if (mediaKind) await window.HexiGridDesktopMedia?.stop?.(mediaKind, false);
      }
      render(latestManifest, latestState);
      feedback.textContent = `${scope} ${checked ? 'granted' : 'revoked'} for this Link. No new pairing is needed.`;
    } catch (error) { feedback.textContent = error.message; }
    finally { setLinkPermissionEditBusy(false); }
  });
  async function updateOwnerTrust(trustLevel) {
    if (linkPermissionEditBusy) return;
    const feedback = document.querySelector('#desktopBridgeFeedback');
    const link = connectedLinks(latestState || {}).find((item) => item.id === document.querySelector('#desktopBridgeLink')?.value);
    if (!link) { feedback.textContent = 'Choose the exact connected agent link first.'; return; }
    if (!setLinkPermissionEditBusy(true)) return;
    try {
      const result = await request(`/api/agent-links/${encodeURIComponent(link.id)}/trust`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trustLevel, approved: true }) });
      latestState.agentLinks = (latestState.agentLinks || []).map((item) => item.id === result.connection.id ? result.connection : item);
      render(latestManifest, latestState);
      feedback.textContent = trustLevel === 'owner' ? 'Owner-agent trust granted to the selected Link.' : 'The selected Link returned to scoped access.';
    } catch (error) { feedback.textContent = error.message; }
    finally { setLinkPermissionEditBusy(false); }
  }
  document.querySelector('#ownerAgentGrant')?.addEventListener('click', () => { void updateOwnerTrust('owner'); });
  document.querySelector('#ownerAgentRevoke')?.addEventListener('click', () => { void updateOwnerTrust('scoped'); });
  document.querySelector('#desktopBridgeMicrophoneDevice')?.addEventListener('change', async (event) => {
    const deviceId = event.currentTarget.value;
    const feedback = document.querySelector('#desktopBridgeFeedback');
    try {
      const result = await window.HexiGridDesktopMedia?.switchMicrophone?.(deviceId);
      if (result?.failures?.length) feedback.textContent = result.failures.join(' ');
      else if (latestState?.settings?.desktopBridge?.enabled) feedback.textContent = 'Microphone switched for this session.';
      renderMicrophoneState(window.HexiGridDesktopMedia?.state?.() || {});
    } catch (error) {
      feedback.textContent = error.message || 'The microphone could not be switched.';
      renderMicrophoneState(window.HexiGridDesktopMedia?.state?.() || {});
    }
  });

  void refreshMicrophoneDevices();
  start();
})();
