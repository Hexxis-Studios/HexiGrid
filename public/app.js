const state = {
  data: null,
  activeView: "overview",
  activeRoomId: null,
  chatTurn: null,
  editingAgentId: null,
  avatarDraft: "",
  avatarModelDraft: null,
  avatarModelFile: null,
  avatarModelRemove: false,
  avatarModelObjectUrl: "",
  onboardingStep: 0,
  network: null,
  usagePeriod: "week",
  activityVisibleCount: 100,
  deferredInstallPrompt: null,
  workspaceFolder: "/",
  workspaceLoaded: false
};
let modelSelectionPending = null;
let incomingVoiceCallPollTimer = 0;
let incomingVoiceCallPollInFlight = false;
const codexDeliveryReview = window.HexiGridCodexDeliveries.attach(document.querySelector('#ownerCodexDeliveries'), { request: api, refresh });
let memoryLearningResumePending = false;
let memoryLearningResumeMessage = '';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

window.hexigridCheckUsageBudget = async () => {
  const { budget } = await api('/api/usage/budget');
  if (budget?.flag === 'exhausted') throw new Error('The local 7-day token budget is exhausted. Increase or disable it in Usage, or wait for older usage to leave the window.');
};

function migrateLocalPreferences() {
  const preferences = window.HexiGridPreferences;
  for (const key of ['theme', 'motion', 'compact', 'button-sounds']) {
    const current = preferences.getItem(`hexigrid-${key}`);
    const legacy = preferences.getItem(`aveniq-${key}`);
    if (current === null && legacy !== null) preferences.setItem(`hexigrid-${key}`, legacy);
  }
}

async function prepareDevelopmentSession() {
  try {
    const response = await fetch('/api/system/identity', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const identity = await response.json();
    if (!identity.developmentFreshStart || !identity.instanceId) return;
    const sessionKey = 'hexigrid-development-session';
    if (localStorage.getItem(sessionKey) === identity.instanceId) return;
    for (const key of Object.keys(localStorage)) if (key.startsWith('hexigrid-') || key.startsWith('aveniq-')) localStorage.removeItem(key);
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('hexigrid-') || key.startsWith('aveniq-')) sessionStorage.removeItem(key);
    localStorage.setItem(sessionKey, identity.instanceId);
  } catch {
    // A development convenience must never prevent the normal app from opening.
  }
}
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
const isHostBrowser = () => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname.toLowerCase());
const isStandaloneBrowser = () => Boolean(window.HexiGridStandalone?.isActive());
function protectHostOnlyControls(root, message = 'Open HexiGrid on the computer that runs it to configure credentials or install local code.') {
  if (isHostBrowser() || !root) return true;
  root.querySelectorAll('input, textarea, select, button').forEach((control) => {
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
  });
  if (!root.querySelector('.host-only-notice')) root.insertAdjacentHTML('afterbegin', `<p class="host-only-notice" role="note">${escapeHtml(message)}</p>`);
  return false;
}
const initials = (name) => String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const timeAgo = (date) => {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(date).toLocaleDateString();
};
const statusLabel = (status) => ({ connected: "Account linked", local_ready: "Local ready", not_connected: "Not connected", setup: "Needs setup" })[status] || "Needs setup";
const statusClass = (status) => status === "connected" ? "linked" : status === "local_ready" ? "local_ready" : "";

class ApiError extends Error {
  constructor(message, body, status) { super(message); this.body = body; this.status = status; }
}

async function api(url, options = {}) {
  if (isStandaloneBrowser()) return window.HexiGridStandalone.request(url, options);
  const csrf = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('hexigrid_csrf='))?.slice('hexigrid_csrf='.length) || '';
  const { headers: optionHeaders, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(url, { ...requestOptions, headers: { "content-type": "application/json", ...(csrf ? { "x-hexigrid-csrf": decodeURIComponent(csrf) } : {}), ...(optionHeaders || {}) } });
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    if (navigator.onLine === false || error instanceof TypeError) window.HexiGridConnectivity?.markOffline();
    throw new ApiError('The HexiGrid server is unavailable. Reconnect and try again; this action was not retried.', { code: 'HOST_UNAVAILABLE' }, 503);
  }
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text().catch(() => '');
  if (window.HexiGridStandalone?.shouldFallback(response, body, contentType, url, options.method || 'GET')) {
    window.HexiGridStandalone.activate();
    return window.HexiGridStandalone.request(url, options);
  }
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status})`, body, response.status);
  return body;
}

async function refreshIncomingVoiceCall() {
  if (!state.data || incomingVoiceCallPollInFlight) return;
  incomingVoiceCallPollInFlight = true;
  try {
    const result = await api('/api/desktop-bridge');
    const bridge = result.callBridge || result.bridge || state.data.settings?.desktopBridge || state.data.desktopBridge || {};
    window.HexiGridIncomingVoiceCall?.update({
      request: api,
      voiceCall: result.voiceCall || { status: 'idle' },
      bridge,
      media: window.HexiGridDesktopMedia?.state?.(),
      transcripts: result.transcripts || []
    });
  } catch {
    // Call monitoring must not interrupt normal app use or spam notices while
    // the local owner session is unavailable. A later poll retries once.
  } finally {
    incomingVoiceCallPollInFlight = false;
  }
}

function startIncomingVoiceCallMonitor() {
  if (incomingVoiceCallPollTimer) return;
  void refreshIncomingVoiceCall();
  incomingVoiceCallPollTimer = window.setInterval(() => { void refreshIncomingVoiceCall(); }, 1000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshIncomingVoiceCall();
});
window.addEventListener('pageshow', () => { if (state.data) void refreshIncomingVoiceCall(); });

async function userConfirm(title, message, accept = "Continue", danger = false) {
  if (typeof window.hexigridModal === "function") return Boolean(await window.hexigridModal({ title, message, accept, danger }));
  return false;
}

async function userInput(title, label, value = "", options = {}) {
  if (typeof window.hexigridModal !== "function") return null;
  const result = await window.hexigridModal({ title, message: options.message || "", accept: options.accept || "Save", fields: [{ label, value, required: options.required !== false, type: options.type || "text", multiline: options.multiline === true }] });
  return result ? result[0] : null;
}

function notify(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.className = "toast"; }, 4200);
}

function agent(agentId) { return state.data.agents.find((item) => item.id === agentId); }
function agentListLabel(item) {
  const duplicates = state.data.agents.filter((candidate) => candidate.name.trim().toLowerCase() === item.name.trim().toLowerCase());
  return duplicates.length > 1 ? `${item.name} · ${String(item.id).slice(-6)}` : item.name;
}
function providerCanAnswer(item) {
  if (item.kind === 'browser-webllm' || item.local || item.hasKey) return true;
  try { return !['opencode.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'router.huggingface.co'].includes(new URL(item.baseUrl).hostname.toLowerCase()); }
  catch { return false; }
}
function activeRoom() { return state.data.rooms.find((room) => room.id === state.activeRoomId && !room.archived) || state.data.rooms.find((room) => !room.archived); }
function approvalProfile(profileId) { return state.data.policyCatalog.approvalProfiles.find((profile) => profile.id === profileId); }
function workMode(modeId) { return state.data.policyCatalog.workModes.find((mode) => mode.id === modeId); }
function availableModels() { return [...state.data.modelCatalog, ...(state.data.providers || []).filter(p=>p.enabled && providerCanAnswer(p)).flatMap(p=>p.modelIds.map(model=>({ id:`provider:${p.id}:${model}`, label:`${p.kind === 'browser-webllm' ? 'This device' : p.name} / ${model}`, free:p.local, provider:p.name, providerId:p.id, remoteModel:model, browser:p.kind === 'browser-webllm', cloud:!p.local, local:p.local, modelMeta:p.modelMeta?.find((item) => item.id === model) || null })))]; }
function modelInfo(modelId) { return availableModels().find((model) => model.id === modelId); }
function modelAllowedByPreference(model) { return state.data.settings.modelPolicy !== 'free-only' || model.free; }
function modelOptions(selected) {
  return availableModels().map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selected ? "selected" : ""} ${modelAllowedByPreference(model) ? '' : 'disabled'}>${escapeHtml(model.label)}${model.free ? ' · no cost' : ''}</option>`).join("");
}

function safeAgentColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : "#8d7dff"; }
function colorTile(value, className = "avatar-color-layer") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="${safeAgentColor(value)}" d="M0 0h1v1H0z"/></svg>`;
  return `<img class="${className}" src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="" aria-hidden="true" />`;
}
function levelClass(value, maximum = 100) { return `level-${Math.max(0, Math.min(20, Math.round((Number(value) || 0) / Math.max(1, maximum) * 20)))}`; }

function avatarMarkup(item, className = "agent-avatar") {
  const fallback = escapeHtml(item.avatar || initials(item.name));
  if (item.avatarImage) return `<div class="${className} has-photo">${colorTile(item.color)}<img class="avatar-photo" src="${escapeHtml(item.avatarImage)}" alt="${escapeHtml(item.name)} profile picture" /></div>`;
  return `<div class="${className}">${colorTile(item.color)}<span class="avatar-initials">${fallback}</span></div>`;
}

const guideTopics = window.HEXIGRID_GUIDES || {};


function renderOverview() {
  window.HexiGridViewRenderers.renderOverview({ state, $, escapeHtml, timeAgo, workMode, approvalProfile, renderAgentCard });
}


function renderUsage() {
  window.HexiGridViewRenderers.renderUsage({ state, $, $$, escapeHtml, timeAgo, agent, avatarMarkup, levelClass });
}



function renderModels() {
  window.HexiGridViewRenderers.renderModels({ state, $, escapeHtml, availableModels, modelOptions, modelAllowedByPreference, avatarMarkup, selectionPending: modelSelectionPending });
}

function renderSetup() {
  window.HexiGridViewRenderers.renderSetup({ state, $, escapeHtml, modelInfo });
}

function renderAccess() {
  codexDeliveryReview.render(state.data.codexDeliveries || []);
  window.HexiGridViewRenderers.renderAccess({ state, $, escapeHtml, workMode, approvalProfile });
}

function renderActivity() {
  window.HexiGridViewRenderers.renderActivity({ state, $, escapeHtml, timeAgo });
}


function renderSettings() {
  window.HexiGridViewRenderers.renderSettings({ state, $, $$, escapeHtml, initials });
}

function renderNetwork() {
  window.HexiGridViewRenderers.renderNetwork({ state, $, escapeHtml });
}

function applyTheme(theme) {
  const valid = ["system-dark", "system-light", "aurora-dark", "aurora-light"];
  const selected = valid.includes(theme) ? theme : "aurora-dark";
  document.documentElement.dataset.theme = selected;
  window.HexiGridPreferences.setItem("hexigrid-theme", selected);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  // Changing appearance must not reset an unsaved profile form.
  $$('[data-theme-choice]').forEach((card) => {
    const active = card.dataset.themeChoice === selected;
    card.classList.toggle('active', active);
    card.setAttribute('aria-pressed', String(active));
  });
}

function applyDevicePreferences() {
  const motion = window.HexiGridPreferences.getItem("hexigrid-motion") !== "off";
  const compact = window.HexiGridPreferences.getItem("hexigrid-compact") === "on";
  document.body.classList.toggle("reduce-motion", !motion);
  document.body.classList.toggle("compact-ui", compact);
  document.body.classList.toggle("touch-device", matchMedia("(pointer: coarse)").matches);
  document.body.classList.toggle("mobile-device", /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
}

function renderDeviceNotice() {
  const isPhone = document.body.classList.contains("mobile-device");
  const notice = $("#deviceNotice");
  if (!isPhone || sessionStorage.getItem("hexigrid-device-notice") === "hidden") return notice.classList.add("hidden");
  const messages = {
    workspace: "Files and commands run on the linked HexiGrid computer. Your phone safely controls them from here.",
    models: "Local AI models run on the linked computer. Your phone can still choose and use them.",
    setup: "Windows-only runners stay on the linked computer. Phone controls remain available after pairing."
  };
  if (!messages[state.activeView]) return notice.classList.add('hidden');
  $("#deviceNoticeText").textContent = messages[state.activeView];
  notice.classList.remove("hidden");
}

function memoryLearningPauseState(data = state.data) {
  const learning = data?.memoryLearning;
  if (typeof learning?.paused === 'boolean') return {
    known: true, paused: learning.paused, pauseReason: learning.pauseReason,
    workerStarted: learning.workerStarted
  };
  const settings = data?.settings;
  if (typeof settings?.memoryLearningPaused === 'boolean') return {
    known: true, paused: settings.memoryLearningPaused, pauseReason: settings.memoryLearningPauseReason,
    workerStarted: undefined
  };
  return { known: false, paused: false, pauseReason: '', workerStarted: undefined };
}

function memoryLearningPauseReason(reason) {
  const reasons = {
    'emergency-stop': 'Automatic learning was paused by Stop. Resume when you are ready for eligible completed work to be processed under current policy again.',
    'restore-review': 'Automatic learning is paused after restoring a backup. Review the restored memories and settings before resuming.',
    'owner-review': 'Automatic learning is paused for owner review. You can resume processing eligible completed work under current policy.',
    'resume-save-failed': 'Automatic learning remains paused because the resume state could not be saved. Resolve the local storage issue before trying again.',
    'resume-unavailable': 'Automatic learning could not start and remains paused. Check local model setup before trying again.'
  };
  return reasons[String(reason || '')] || reasons['owner-review'];
}

function renderMemoryLearningNotice() {
  const notice = $('#memoryLearningPausedNotice');
  if (!notice) return;
  const status = memoryLearningPauseState();
  const paused = status.known && status.paused;
  const button = $('#memoryLearningResume');
  notice.classList.toggle('hidden', !paused);
  if (button) {
    button.hidden = !paused;
    button.disabled = !paused || memoryLearningResumePending;
  }
  if (paused) {
    $('#memoryLearningPausedReason').textContent = memoryLearningPauseReason(status.pauseReason);
    $('#memoryLearningPausedMessage').textContent = memoryLearningResumeMessage;
  }
}

function applyMemoryLearningResumeStatus(result) {
  const returned = result?.memoryLearning;
  const returnedSettings = result?.settings;
  const nextLearning = returned && typeof returned.paused === 'boolean'
    ? returned
    : typeof returnedSettings?.memoryLearningPaused === 'boolean'
      ? { paused: returnedSettings.memoryLearningPaused, pauseReason: returnedSettings.memoryLearningPauseReason || '' }
      : null;
  if (!nextLearning || !state.data) return false;
  state.data = {
    ...state.data,
    memoryLearning: { ...(state.data.memoryLearning || {}), ...nextLearning },
    ...(returnedSettings ? { settings: { ...(state.data.settings || {}), ...returnedSettings } } : {})
  };
  return true;
}

function memoryLearningResumeFailure(error, status, { refreshConfirmed = true } = {}) {
  if (!refreshConfirmed && status.known && status.paused) return 'The last confirmed status is paused, but the current server status could not be checked. Refresh and retry before relying on automatic learning.';
  if (!status.known || !status.paused) return 'The resume request did not complete, and the latest status does not confirm whether learning is running. Refresh Memory before relying on automatic learning.';
  const message = String(error?.message || '');
  if (/action cancelled/i.test(message)) return 'Approval was cancelled. Automatic learning remains paused.';
  if (/read-only/i.test(message)) return 'This workspace is read-only. Restore local write access before trying again; automatic learning remains paused.';
  if (/authenticated local owner|computer running hexigrid/i.test(message)) return 'Resume requires an authenticated owner session on the computer running HexiGrid. Automatic learning remains paused.';
  if (/approval|policy|blocked|denied/i.test(message)) return 'The current approval policy did not allow resume. Review the policy and try again; automatic learning remains paused.';
  if (/save|persist|storage|disk/i.test(message)) return 'HexiGrid could not save the resume state. Resolve the local storage issue and retry; automatic learning remains paused.';
  if (/start|unavailable|cannot resume/i.test(message)) return 'Automatic learning could not start. Check local model setup and retry; it remains paused.';
  return 'Resume failed. Check the local workspace and try again; automatic learning remains paused.';
}

async function resumeMemoryLearning() {
  const current = memoryLearningPauseState();
  if (memoryLearningResumePending || !current.known || !current.paused) return;
  memoryLearningResumePending = true;
  memoryLearningResumeMessage = 'Waiting for the current owner approval and policy check.';
  renderMemoryLearningNotice();
  try {
    const result = await approvedRequest('/api/memory-learning/resume', {
      method: 'POST', body: JSON.stringify({})
    }, 'Resume local automatic learning for eligible completed work? Eligible facts may be saved as unverified memories, and changes needing review may be queued for owner review. Resuming does not verify whether any claim is true. Current policy still applies.');
    const returnedStatus = applyMemoryLearningResumeStatus(result);
    memoryLearningResumeMessage = '';
    renderMemoryLearningNotice();
    const refreshConfirmed = await refresh();
    const latest = memoryLearningPauseState();
    if (latest.known && !latest.paused && latest.workerStarted === true) notify('Automatic memory learning resumed.');
    else if (latest.known && latest.paused) {
      memoryLearningResumeMessage = refreshConfirmed || returnedStatus
        ? 'The server still reports learning paused. Review the status above and try again when ready.'
        : 'The last confirmed status is paused, but the current server status could not be checked. Refresh before relying on automatic learning.';
      renderMemoryLearningNotice();
    } else notify('The resume request completed, but the current status does not confirm that automatic learning is running.', true);
  } catch (error) {
    const refreshConfirmed = await refresh();
    const latest = memoryLearningPauseState();
    memoryLearningResumeMessage = memoryLearningResumeFailure(error, latest, { refreshConfirmed });
    renderMemoryLearningNotice();
    if (!latest.known || !latest.paused) notify(memoryLearningResumeMessage, true);
  } finally {
    memoryLearningResumePending = false;
    renderMemoryLearningNotice();
  }
}

function renderAll({ preserveCommunication = false } = {}) {
  if (!state.data) return;
  renderMemoryLearningNotice();
  renderAccess();
  renderOverview();
  renderAgents();
  renderRooms();
  renderModels();
  renderSetup();
  renderActivity();
  renderUsage();
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderTasks === 'function') renderTasks();
  if (typeof renderPlugins === 'function') renderPlugins();
  if (typeof renderSecurity === 'function') renderSecurity();
  renderGuide();
  renderSettings();
  renderNetwork();
  if (!preserveCommunication) renderCommunication();
  const hasModels = availableModels().length > 0;
  $("#localStatus").textContent = hasModels ? "" : "Choose an AI connection";
  $("#localStatus").parentElement.classList.toggle('hidden', hasModels);
  window.dispatchEvent(new CustomEvent("hexigrid:rendered"));
}

function setMobileNavigation(open, { restoreFocus = true } = {}) {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const visible = mobile && open;
  const sidebar = document.querySelector('#workspaceNavigation');
  const toggle = document.querySelector('.mobile-menu');
  document.body.classList.toggle('nav-open', visible);
  sidebar.inert = mobile && !visible;
  sidebar.setAttribute('aria-hidden', String(mobile && !visible));
  document.querySelector('.nav-scrim').inert = !visible;
  if (visible) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
  else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
  for (const element of document.querySelectorAll('.main-content,.mobile-header,.mobile-bottom-nav')) element.inert = visible;
  toggle.setAttribute('aria-expanded', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Close navigation' : 'Open navigation');
  if (visible) sidebar.querySelector('.sidebar-close').focus();
  else if (mobile && restoreFocus) toggle.focus({ preventScroll: true });
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const compact = !mobile && Boolean(collapsed);
  document.body.classList.toggle('sidebar-collapsed', compact);
  const sidebar = document.querySelector('#workspaceNavigation');
  const toggle = document.querySelector('#sidebarCollapseToggle');
  const inert = mobile && !document.body.classList.contains('nav-open');
  sidebar.inert = inert;
  sidebar.setAttribute('aria-hidden', String(inert));
  const label = compact ? 'Expand navigation' : 'Collapse navigation';
  toggle.setAttribute('aria-expanded', String(!compact));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  if (persist) window.HexiGridPreferences.setItem('hexigrid-sidebar-collapsed', compact ? 'on' : 'off');
  return compact;
}

function viewFromHash(hash) {
  const candidate = String(hash || '').replace(/^#/, '');
  return /^[a-z][a-z-]*$/.test(candidate) && document.getElementById(`view-${candidate}`)
    ? candidate : 'overview';
}

function showView(view, { updateHistory = true } = {}) {
  view = viewFromHash(`#${view}`);
  if (updateHistory && window.location.hash !== `#${view}`) {
    window.history.pushState(null, '', `#${view}`);
  }
  state.activeView = view;
  setMobileNavigation(false, { restoreFocus: false });
  $$(".view").forEach((section) => section.classList.toggle("active-view", section.id === `view-${view}`));
  $$('[data-view]').forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  window.HexiGridNavigation?.activate(view);
  const titles = {
    overview: 'Home', agents: 'Agents', memory: 'Memory', room: 'Chat', live: 'Calls',
    communication: 'Conversation style', models: 'AI models', workspace: 'Workspace',
    assistant: 'Assistant', access: 'Permissions', setup: 'Accounts and devices',
    activity: 'Activity', usage: 'AI usage', providers: 'AI providers', integrations: 'Tools & integrations', tasks: 'Tasks',
    plugins: 'Plugins and tools', guide: 'Help', settings: 'Settings'
  };
  $("#viewTitle").textContent = titles[view] || PRODUCT.name;
  // A destination starts at its own top, rather than inheriting another page's scroll.
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  const heading = $('#viewTitle').getClientRects().length ? $('#viewTitle') : document.querySelector('.active-view h2');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  renderDeviceNotice();
  if (view === "workspace" && !state.workspaceLoaded) loadWorkspace("/", true);
  if (view === "memory") {
    if (!state.memoryRecall) state.memoryRecall = window.HexiGridViewRenderers.createMemoryRecall({
      healthReports: () => state.data?.memoryLearning?.maintenance || [],
      root: $('#humanMemoryRecall'), request: api, agents: () => window.HexiGridViewRenderers.orderAgents(state.data?.agents || [], state.data?.agentLinks || []), label: agentListLabel, openProfile: (id) => openAgentModal(id, { section: 'memory' }), ask: (options) => window.hexigridModal(options)
    });
    void state.memoryRecall.refresh();
    if (!state.memoryReview) state.memoryReview = window.HexiGridViewRenderers.createMemoryReview({
      root: $("#humanMemoryReview"), request: api, agents: () => state.data?.agents || []
    });
    void state.memoryReview.refresh();
    if (!state.memorySharing) state.memorySharing = window.HexiGridMemorySharing.create({ root: $('#humanMemorySharing'), request: api, agents: () => state.data?.agents || [], links: () => state.data?.agentLinks || [] });
    void state.memorySharing.refresh();
  }
}

function openAgentLinkInvite() {
  closeConnectModal();
  showView('integrations');
  setTimeout(() => document.querySelector('#desktopInviteForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
}

async function updateSettings(patch, message, preserveCommunication = false) {
  try {
    const response = await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
    state.data.settings = response.settings;
    state.data.bridge.model = response.settings.model;
    renderAll({ preserveCommunication });
    if (message) notify(message);
  } catch (error) { notify(error.message, true); }
}




async function chooseModel(modelId) {
  if (modelSelectionPending) { renderModels(); return; }
  modelSelectionPending = { model: modelId };
  renderModels();
  try {
    const response = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ model: modelId }) });
    state.data.settings = response.settings;
    state.data.bridge.model = response.settings.model;
    if (response.settings.model !== modelId) throw new Error('The requested model was not saved. Refresh AI connections and choose an available model.');
    renderAll({ preserveCommunication: true });
    notify(`${modelInfo(modelId)?.label || modelId} is now the default model.`);
  } catch (error) { notify(error.message, true); }
  finally { modelSelectionPending = null; renderModels(); }
}

async function refreshModels() {
  if (!state.data) {
    notify("HexiGrid is still loading. Try again when the workspace opens.", true);
    return;
  }
  try {
    const response = await api("/api/models/refresh", { method: "POST" });
    const data = state.data;
    if (!data) {
      notify("HexiGrid is still loading. Try again when the workspace opens.", true);
      return;
    }
    data.modelCatalog = response.models;
    if (data.bridge) data.bridge.modelCatalogError = response.error || '';
    renderModels(); notify(`Found ${response.models.length} current models.`);
  } catch (error) { notify(error.message, true); }
}

async function assignAgentModel(agentId, model) {
  if (modelSelectionPending) { renderModels(); return; }
  modelSelectionPending = { agentId, model };
  renderModels();
  try {
    const response = await api(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ model }) });
    const index = state.data.agents.findIndex((item) => item.id === agentId);
    if (index !== -1) state.data.agents[index] = response.agent;
    if (response.agent.model !== model) throw new Error('The requested model was not saved. Refresh AI connections and choose an available model.');
    renderAll({ preserveCommunication: true }); notify(`${response.agent.name} will use ${modelInfo(model)?.label || model}.`);
  } catch (error) { notify(error.message, true); }
  finally { modelSelectionPending = null; renderModels(); }
}

async function askAssistant(event) {
  event.preventDefault();
  const input = $("#assistantInput");
  const content = input.value.trim();
  if (!content) return;
  const messages = $("#assistantMessages");
  messages.insertAdjacentHTML("beforeend", `<div class="assistant-message owner"><strong>You</strong><br>${escapeHtml(content)}</div>`);
  input.value = ""; input.disabled = true;
  try {
    const selected = modelInfo(state.data.settings.model);
    let response;
    if (selected?.browser) {
      if (!window.HexiGridOnDevice?.complete) throw new Error("The browser model engine is unavailable. Refresh the page or choose another model.");
      const generated = await window.HexiGridOnDevice.complete({ modelId: selected.remoteModel, messages: [{ role: "system", content: "You are the local HexiGrid control assistant. Explain setup and agent workflows in plain language. Never claim to have changed anything or used a tool unless the dashboard confirms it." }, { role: "user", content } ] });
      await api("/api/usage/browser", { method: "POST", body: JSON.stringify({ model: state.data.settings.model, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, inputText: content, outputText: generated.content }) });
      response = { content: generated.content, model: state.data.settings.model };
    } else response = await api("/api/assistant", { method: "POST", body: JSON.stringify({ content }) });
    messages.insertAdjacentHTML("beforeend", `<div class="assistant-message"><strong>HexiGrid · ${escapeHtml(modelInfo(response.model)?.label || response.model)}</strong><br>${escapeHtml(response.content)}</div>`);
  } catch (error) {
    input.value = content;
    const retryAdvice = /7-day token budget is exhausted/i.test(error.message || '')
      ? 'Open AI usage to adjust the workspace budget, or wait for older usage to expire. Switching models does not reset this budget.'
      : 'Check AI connections or choose another default model above, then retry.';
    messages.insertAdjacentHTML("beforeend", `<div class="assistant-message error-message"><strong>Unavailable</strong><br>${escapeHtml(error.message)}<br>${retryAdvice} Your request is kept in the input.</div>`);
  }
  finally { input.disabled = false; messages.scrollTop = messages.scrollHeight; }
}



function renderOnboarding() {
  const step = Math.max(0, Math.min(5, state.onboardingStep));
  $$('[data-onboarding-step]').forEach((section) => section.classList.toggle("hidden", Number(section.dataset.onboardingStep) !== step));
  $("#onboardingProgressBar").className = `onboarding-progress-${step}`;
  $("#onboardingDots").innerHTML = Array.from({ length: 6 }, (_, index) => `<i class="${index === step ? "active" : ""}"></i>`).join("");
  $("#onboardingBack").classList.toggle("hidden", step === 0 || step === 5);
  $("#onboardingNext").classList.toggle("hidden", step === 5);
  $("#onboardingNext").textContent = step === 0 ? "Begin setup" : step === 4 ? "Finish" : "Continue";
  $("#onboardingOwnerName").value = step === 1 ? (state.data.settings.owner?.displayName || "Owner") : $("#onboardingOwnerName").value;
  const models = availableModels().filter(model=>model.free).slice(0, 3);
  $("#onboardingModelStatus").textContent = availableModels().length ? `${availableModels().length} model${availableModels().length===1?' is':'s are'} ready from connections you chose.` : "Nothing is connected yet. Choose an API key, a local model app, or a detected signed-in computer tool.";
  $("#onboardingModelList").innerHTML = models.map((model) => `<span>${escapeHtml(model.label)} <strong>No cost</strong></span>`).join("") || `<span>Model connection <strong>Needed</strong></span>`;
}

function showOnboarding(start = 0) {
  state.onboardingStep = start;
  renderOnboarding();
  $("#onboarding").classList.remove("hidden");
  document.body.classList.add("overlay-open");
}

async function finishOnboarding(destination = null) {
  const displayName = $("#onboardingOwnerName").value.trim() || state.data.settings.owner?.displayName || "Owner";
  await updateSettings({ owner: { displayName }, setupAcknowledged: true }, "Welcome to HexiGrid.", true);
  $("#onboarding").classList.add("hidden");
  document.body.classList.remove("overlay-open");
  if (destination) showView(destination);
}

async function loadNetwork() {
  try { state.network = await api("/api/network"); renderNetwork(); window.renderAgentRelay?.(); window.renderTailnetLink?.(); }
  catch { state.network = { enabled: false, urls: [], pairingCode: "" }; }
}

async function copyMobileAddress() {
  const url = state.network?.tunnel?.running ? state.network.tunnel.url : state.network?.urls?.[0];
  const code = state.network?.pairingCode;
  if (!url || !code) return notify("Turn on private-network mode first.", true);
  const pairingUrl = `${url}/?pair=${encodeURIComponent(code)}`;
  try { await navigator.clipboard.writeText(pairingUrl); notify("Private phone pairing link copied."); }
  catch { await userInput("Phone address", "Copy this address", pairingUrl, { required: false, accept: "Done" }); }
}

async function toggleRemoteLink() {
  const running = state.network?.tunnel?.running;
  if (running) {
    if (!await userConfirm("Close remote link?", "Devices using the temporary link will disconnect now.", "Close link", true)) return;
    await api('/api/network/tunnel', { method: 'DELETE', body: JSON.stringify({ approved: true }) });
    notify('Temporary remote link closed.');
  } else {
    if (!await userConfirm("Open a temporary remote link?", "This uses Cloudflare Quick Tunnel. The random link is public, but HexiGrid still requires the current pairing code. A valid code signs the invited device into a temporary workspace session. Use Connect mode, and close it when the call ends.", "Open link")) return;
    const result = await api('/api/network/tunnel', { method: 'POST', body: JSON.stringify({ approved: true }) });
    notify('Temporary remote link opened.');
    state.network = { ...state.network, tunnel: result.tunnel, pairingCode: result.pairingCode };
  }
  await loadNetwork();
}

async function installPwa() {
  if (matchMedia("(display-mode: standalone)").matches) return;
  if (state.deferredInstallPrompt) {
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    return renderSettings();
  }
  openGuideTopic("mobile");
  notify(location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "Use your browser menu and choose Install app or Add to home screen." : "A private HTTP address can be bookmarked. Full PWA installation needs localhost or HTTPS.");
}

async function refresh() {
  try {
    window.HexiGridConnectivity?.markVerifying();
    const firstSnapshot = !state.data;
    state.data = await api("/api/bootstrap");
    if (!memoryLearningResumePending) memoryLearningResumeMessage = '';
    window.HexiGridConnectivity?.markOnline();
    document.body.classList.toggle('standalone-browser', isStandaloneBrowser());
    if (!activeRoom()) state.activeRoomId = state.data.rooms[0]?.id;
    renderAll();
    startIncomingVoiceCallMonitor();
    if (firstSnapshot) showView(viewFromHash(window.location.hash), { updateHistory: false });
    await loadNetwork();
    startRoomEvents();
    if (window.hexigridAuthInitialized && !state.data.settings.setupAcknowledged && $("#onboarding").classList.contains("hidden") && $("#authGate").classList.contains("hidden")) showOnboarding(0);
    return true;
  } catch (error) {
    if (error.status === 401 && error.body?.authRequired && typeof window.showAuthGate === 'function') {
      window.HexiGridConnectivity?.markOnline();
      window.showAuthGate();
    }
    else {
      window.HexiGridConnectivity?.markOffline();
      notify(`HexiGrid could not load: ${error.message}`, true);
    }
    return false;
  } finally { window.hexigridBoot?.complete(); }
}

document.addEventListener("click", async (event) => {
  const usageBar = event.target.closest("#usageChart [data-usage-detail]");
  if (usageBar) { $("#usageChartDetail").textContent = usageBar.dataset.usageDetail; return; }
  const nav = event.target.closest("[data-view]");
  if (nav) return showView(nav.dataset.view);
  const target = event.target.closest("[data-action], [data-view-target], [data-usage-period]");
  if (!target) return;
  if (target.dataset.viewTarget) return showView(target.dataset.viewTarget);
  const action = target.dataset.action;
  if (action === "resume-memory-learning") { await resumeMemoryLearning(); return; }
  if (action === "open-add-agent") openAgentModal();
  if (action === "open-connect-agent") openConnectModal();
  if (action === "close-connect-modal") closeConnectModal();
  if (action === "open-agent-link-invite") openAgentLinkInvite();
  if (action === "choose-agent-source" && target.dataset.source === "ilands") { closeConnectModal(); showView("integrations"); }
  if (action === "choose-agent-source" && target.dataset.source === "local") { closeConnectModal(); openAgentModal(); $("#transport").value = "local-opencode"; updateAgentConnectionSummary(); }
  if (action === "copy-byoa-instruction") { const instruction = "Open https://ilands.ai/agent.md and connect this local agent to iLands. Detect this machine's OS and architecture first, then follow only a platform branch and Harness that the live guide reports as certified. Complete other in-scope steps automatically; only ask me for browser login/approval, permissions, platform prerequisites, and onboarding answers."; try { await navigator.clipboard.writeText(instruction); notify("Official iLands connection instructions copied."); } catch { await userInput("iLands connection instructions", "Copy this instruction", instruction, { required: false, multiline: true, accept: "Done" }); } }
  if (action === "finish-ilands-profile") { closeConnectModal(); openAgentModal(); $("#transport").value = "ilands-runner"; updateAgentConnectionSummary(); }
  if (action === "onboarding-connect-agent") { $("#onboarding").classList.add("hidden"); openConnectModal(); }
  if (action === "close-modal") closeAgentModal();
  if (action === "edit-agent") openAgentModal(target.dataset.agentId);
  if (action === "duplicate-agent") duplicateAgent(target.dataset.agentId);
  if (action === "remove-agent") removeAgentById(target.dataset.agentId);
  if (action === "new-room") newRoom();
  if (action === "rename-room") renameRoom();
  if (action === "archive-room") setRoomArchived(activeRoom()?.id, true);
  if (action === "restore-room") setRoomArchived(target.dataset.roomId, false);
  if (action === "stop-chat") stopChat();
  if (action === 'refresh-room') refreshRoomReplies();
  if (action === 'save-local-reply') saveLocalReply(target.dataset.replyId);
  if (action === 'cancel-linked-reply') cancelLinkedRoomReply(target.dataset.requestId);
  if (action === "select-room") { state.activeRoomId = target.dataset.roomId; renderRooms(); }
  if (action === "choose-mode") updateSettings({ workMode: target.dataset.mode }, `${workMode(target.dataset.mode)?.label} mode is active.`, true);
  if (action === "choose-approval") updateSettings({ approvalPolicy: target.dataset.approval }, `${approvalProfile(target.dataset.approval)?.label} is active.`, true);
  if (action === "save-subagents") updateSettings({ subagents: { enabled: $("#subagentsEnabled").checked, maxConcurrent: Number($("#subagentLimit").value) } }, "Subagent limits saved.", true);
  if (action === "clear-goal") updateSettings({ activeGoal: { title: "" } }, "Goal cleared.", true);
  if (action === "focus-composer") { showView("room"); $("#chatInput").focus(); }
  if (action === "open-computer-access") {
    showView("integrations");
    requestAnimationFrame(() => document.querySelector('#view-integrations .desktop-module')?.scrollIntoView({ block: 'start' }));
  }
  if (action === "refresh-bridge") { await refresh(); notify("Local connections checked."); }
  if (action === "refresh-models") refreshModels();
  if (action === "choose-model") chooseModel(target.dataset.model);
  if (action === "add-communication-example") addCommunicationExample();
  if (action === "remove-communication-example") removeCommunicationExample(target.dataset.exampleIndex);
  if (action === "save-communication") saveCommunication();
  if (action === "reset-communication") { renderCommunication(state.data.communicationDefaults); notify("Default draft restored. Save when it looks right."); }
  if (action === "preview-communication") previewCommunication();
  if (action === "show-more-activity") { state.activityVisibleCount += 100; renderActivity(); }
  if (action === "open-workspace-folder") loadWorkspace(target.dataset.path);
  if (action === "open-workspace-file") openWorkspaceFile(target.dataset.path);
  if (action === "workspace-up") {
    const parts = state.workspaceFolder.split("/").filter(Boolean); parts.pop(); loadWorkspace(`/${parts.join("/")}`);
  }
  if (action === "save-workspace-file") saveWorkspaceFile();
  if (action === "reload-workspace-file") openWorkspaceFile($('#workspacePathInput').value);
  if (action === "configure-google") { showView("settings"); document.querySelector('#syncTools')?.scrollIntoView({ behavior: 'smooth' }); }
  if (action === "future-provider") { showView("plugins"); notify("Install a connector or tool from a local plugin bundle."); }
  if (action === "toggle-mobile-nav") setMobileNavigation(!document.body.classList.contains('nav-open'));
  if (action === "close-mobile-nav") setMobileNavigation(false);
  if (action === "toggle-sidebar-collapse") { setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')); return; }
  if (action === "dismiss-device-notice") { sessionStorage.setItem("hexigrid-device-notice", "hidden"); $("#deviceNotice").classList.add("hidden"); }
  if (action === "open-guide-topic") openGuideTopic(target.dataset.guide);
  if (action === "open-guide-from-onboarding") openGuideTopic(target.dataset.guide);
  if (action === "copy-integration-prompt") {
    const prompt = guideTopics[target.dataset.guide]?.prompt;
    if (prompt) {
      try { await navigator.clipboard.writeText(prompt); notify("Safe setup prompt copied."); }
      catch { await userInput("Safe setup prompt", "Copy this prompt", prompt, { required: false, multiline: true, accept: "Done" }); }
    }
  }
  if (action === "open-connections-from-onboarding") { $("#onboarding").classList.add("hidden"); showView("providers"); }
  if (action === "open-prompt-center") { $("#onboarding").classList.add("hidden"); showView("integrations"); setTimeout(() => document.querySelector('#setupPromptCenter')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }
  if (action === "close-guide-topic") closeGuideTopic();
  if (action === "restart-onboarding") showOnboarding(0);
  if (action === "onboarding-next") { state.onboardingStep = Math.min(5, state.onboardingStep + 1); renderOnboarding(); }
  if (action === "onboarding-back") { state.onboardingStep = Math.max(0, state.onboardingStep - 1); renderOnboarding(); }
  if (action === "skip-onboarding") finishOnboarding();
  if (action === "finish-onboarding") finishOnboarding();
  if (action === "finish-to-guide") finishOnboarding("guide");
  if (action === "save-owner") updateSettings({ owner: { displayName: $("#ownerName").value } }, "Local profile saved.", true);
  if (action === "copy-mobile-address") copyMobileAddress();
  if (action === "toggle-remote-link") toggleRemoteLink().catch((error) => notify(error.message, true));
  if (action === "install-pwa") installPwa();
  if (action === "remove-agent-photo") { state.avatarDraft = ""; renderAgentPhoto(); }
  if (action === 'animate-agent-picture') void animateAgentPicture();
  if (action === "remove-agent-model") { clearAvatarModelDraft(true); renderAgentPhoto(); }
  if (target.dataset.usagePeriod) { state.usagePeriod = target.dataset.usagePeriod; renderUsage(); }
});

document.addEventListener("focusin", (event) => {
  const usageBar = event.target.closest("#usageChart [data-usage-detail]");
  if (usageBar) $("#usageChartDetail").textContent = usageBar.dataset.usageDetail;
});

document.addEventListener("input", (event) => {
  if (event.target.closest("#view-communication")) updateCommunicationSaveState();
});
document.addEventListener("change", (event) => {
  if (event.target.closest("#view-communication")) updateCommunicationSaveState();
});

document.addEventListener("change", (event) => {
  if (event.target.id === 'transport') updateAgentConnectionSummary();
  if (event.target.matches("[data-agent-toggle]")) updateRoomAgents();
  if (event.target.matches("[data-agent-model]")) assignAgentModel(event.target.dataset.agentModel, event.target.value);
  if (event.target.matches("[data-theme-choice]")) applyTheme(event.target.dataset.themeChoice);
});

document.addEventListener("click", (event) => {
  const themeCard = event.target.closest("[data-theme-choice]");
  if (themeCard) applyTheme(themeCard.dataset.themeChoice);
});

$("#workModeSelect").addEventListener("change", (event) => updateSettings({ workMode: event.target.value }, "Work mode changed.", true));
$('#agentAppearanceDisclosure').addEventListener('toggle', () => {
  const item = state.editingAgentId ? agent(state.editingAgentId) : null;
  renderAgentPhoto($('#agentName').value || 'Agent', item?.color || '#8d7dff');
});
$("#approvalSelect").addEventListener("change", (event) => updateSettings({ approvalPolicy: event.target.value }, "Approval level changed.", true));
$("#globalModelSelect").addEventListener("change", (event) => chooseModel(event.target.value));
$("#defaultModelSelect").addEventListener("change", (event) => chooseModel(event.target.value));
$("#modelPolicySelect").addEventListener("change", (event) => updateSettings({ modelPolicy: event.target.value }, event.target.value === 'free-only' ? 'Only models reported as no-cost can now be selected.' : 'All models from your connected services can now be selected.', true));
$("#refreshBtn").addEventListener("click", refresh);
$("#agentSearch").addEventListener("input", renderAgents);
$("#activitySearch").addEventListener("input", () => { state.activityVisibleCount = 100; renderActivity(); });
$("#activityFilter").addEventListener("change", () => { state.activityVisibleCount = 100; renderActivity(); });
$('#activityOutcome').addEventListener('change', () => { state.activityVisibleCount = 100; renderActivity(); });
$("#usageAgentFilter").addEventListener("change", renderUsage);
$('#usageBudgetInput').addEventListener('input', event => { event.target.dataset.edited = 'true'; });
$('#usageBudgetReload').addEventListener('click', async () => {
  try {
    state.data = await api('/api/bootstrap');
    $('#usageBudgetInput').dataset.edited = 'false'; renderUsage();
    $('#usageBudgetStatus').textContent = 'Current budget loaded. Unsaved changes cleared.';
  } catch (error) { $('#usageBudgetStatus').textContent = error.message; }
});
$('#usageBudgetForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#usageBudgetInput'), buttons = [...event.currentTarget.querySelectorAll('button')];
  if (buttons.some(button => button.disabled)) return;
  const tokens = event.submitter?.value === 'clear' ? null : Number(input.value);
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 1000000000)) {
    $('#usageBudgetStatus').textContent = 'Enter a whole number from 1 to 1,000,000,000, or choose Disable budget.'; return;
  }
  buttons.forEach(button => { button.disabled = true; });
  let committed = false;
  try {
    await api('/api/usage/budget', { method: 'PUT', body: JSON.stringify({ tokens, expectedTokens: JSON.parse(input.dataset.expectedTokens || 'null'), approved: true }) });
    committed = true;
    input.dataset.edited = 'false';
    state.data = await api('/api/bootstrap'); renderUsage();
    $('#usageBudgetStatus').textContent = tokens === null ? 'Local token budget disabled.' : 'Local token budget saved.';
  } catch (error) {
    $('#usageBudgetStatus').textContent = committed
      ? `Budget change saved, but the display could not refresh. ${error.message} Choose Reload budget to read the saved setting.`
      : `${error.message} Your entry is retained; Reload budget reads the current setting.`;
  } finally { buttons.forEach(button => { button.disabled = false; }); }
});
$("#agentForm").addEventListener("submit", saveAgent);
$("#agentName").addEventListener("input", () => { if (!state.avatarDraft) renderAgentPhoto(); });
$("#agentPhotoInput").addEventListener("change", async (event) => {
  try { state.avatarDraft = await resizeProfileImage(event.target.files?.[0]); $('#agentAnimatePortrait').checked = event.target.files?.[0]?.type !== 'image/gif'; renderAgentPhoto(); }
  catch (error) { notify(error.message, true); event.target.value = ""; }
});
$("#agentModelInput").addEventListener("change", (event) => {
  try { chooseAvatarModel(event.target.files?.[0]); renderAgentPhoto(); }
  catch (error) { notify(error.message, true); event.target.value = ""; }
});
$("#deleteAgentBtn").addEventListener("click", deleteAgent);
$("#chatForm").addEventListener("submit", sendChat);
$("#assistantForm").addEventListener("submit", askAssistant);
$("#terminalForm").addEventListener("submit", runTerminal);
$("#goalForm").addEventListener("submit", (event) => { event.preventDefault(); updateSettings({ activeGoal: { title: $("#goalInput").value, status: "active" } }, "Goal saved.", true); });
$("#agentModal").addEventListener("click", (event) => { if (event.target.id === "agentModal") closeAgentModal(); });
$("#connectModal").addEventListener("click", (event) => { if (event.target.id === "connectModal") closeConnectModal(); });
$("#guideDrawer").addEventListener("click", (event) => { if (event.target.id === "guideDrawer") closeGuideTopic(); });
$("#motionEnabled").addEventListener("change", (event) => { window.HexiGridPreferences.setItem("hexigrid-motion", event.target.checked ? "on" : "off"); applyDevicePreferences(); });
$("#buttonSoundsEnabled").addEventListener("change", (event) => { window.HexiInteractions?.setSoundsEnabled(event.target.checked, { preview: true }); });
$("#compactMode").addEventListener("change", (event) => { window.HexiGridPreferences.setItem("hexigrid-compact", event.target.checked ? "on" : "off"); applyDevicePreferences(); });
window.addEventListener("resize", renderDeviceNotice);
window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
  setMobileNavigation(false, { restoreFocus: false });
  setSidebarCollapsed(window.HexiGridPreferences.getItem('hexigrid-sidebar-collapsed') === 'on', { persist: false });
});
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredInstallPrompt = event; if (state.data) renderSettings(); });
window.addEventListener('hexigrid:reconnect-requested', () => refresh());
window.addEventListener('pageshow', () => { if (state.data) startRoomEvents(); });
window.addEventListener('hashchange', () => {
  if (state.data) showView(viewFromHash(window.location.hash), { updateHistory: false });
});
document.addEventListener("keydown", (event) => {
  if (document.body.classList.contains('nav-open')) {
    if (event.key === 'Escape') { event.preventDefault(); setMobileNavigation(false); return; }
    if (event.key === 'Tab') {
      const controls = [...document.querySelectorAll('#workspaceNavigation button,#workspaceNavigation a[href]')].filter((element) => !element.disabled && element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
  if (event.key === 'Escape') { closeAgentModal(); closeConnectModal(); closeGuideTopic(); }
});

async function initialize() {
  await prepareDevelopmentSession();
  migrateLocalPreferences();
  applyTheme(window.HexiGridPreferences.getItem("hexigrid-theme") || "aurora-dark");
  applyDevicePreferences();
  setMobileNavigation(false, { restoreFocus: false });
  setSidebarCollapsed(window.HexiGridPreferences.getItem('hexigrid-sidebar-collapsed') === 'on', { persist: false });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  await refresh();
  if (state.data) showView(viewFromHash(window.location.hash), { updateHistory: false });
}

initialize();
