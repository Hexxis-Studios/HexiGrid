import { signedLinkRequest } from './agent-link-browser-client.js';
import { AgentRelayClient } from './agent-link-relay-client.js';
import { availableAgentLinkActions, prepareAgentLinkAction } from './agent-link-actions.js';

const form = document.querySelector('#linkPairForm');
const includedSkill = document.querySelector('#includedLinkSkill');
if (includedSkill) {
  void fetch('/agent-link/skill', { credentials: 'omit', cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('The skill could not be loaded. Use the included download link to retry.');
    const bundle = await response.json();
    const skill = bundle.files?.find(file => file.path === bundle.entrypoint) || bundle.files?.find(file => file.path === 'SKILL.md');
    if (!skill) throw new Error('The skill bundle is incomplete. Retry the download before pairing.');
    includedSkill.textContent = skill.content;
  }).catch(error => { includedSkill.textContent = error.message; });
}
const status = document.querySelector('#linkStatus');
const control = document.querySelector('#desktopControl');
const controlStatus = document.querySelector('#desktopControlStatus');
const controlBadge = document.querySelector('#desktopControlBadge');
const frameWrap = document.querySelector('#desktopFrameWrap');
const frame = document.querySelector('#desktopFrame');
const mediaPanel = document.querySelector('#desktopMedia');
const mediaStatus = document.querySelector('#desktopMediaStatus');
const camera = document.querySelector('#desktopCamera');
const audioEnable = document.querySelector('#desktopAudioEnable');
const pointerControls = document.querySelector('#pointerControls');
const keyboardControls = document.querySelector('#keyboardControls');
const keyCapture = document.querySelector('#keyCapture');
const stopButton = document.querySelector('#desktopAgentStop');
const relayDiagnostics = document.querySelector('#relayDiagnostics');
const relayProofLog = document.querySelector('#relayProofLog');
const agentWorkspace = document.querySelector('#agentWorkspace');
const agentOrientation = document.querySelector('#agentOrientation');
const agentCapabilities = document.querySelector('#agentCapabilities');
const agentActionForm = document.querySelector('#agentActionForm');
const agentActionSelect = document.querySelector('#agentActionSelect');
const agentActionInput = document.querySelector('#agentActionInput');
const agentActionRun = document.querySelector('#agentActionRun');
const agentActionStatus = document.querySelector('#agentActionStatus');
const agentActionResult = document.querySelector('#agentActionResult');
const invitation = new URL(location.href);
const inviteId = invitation.searchParams.get('invite') || '';
const fragment = new URLSearchParams(invitation.hash.slice(1));
const inviteSecret = fragment.get('secret') || '';
const relayDeviceId = invitation.searchParams.get('device') || '';
const relayMode = invitation.searchParams.get('relay') === '1' && Boolean(relayDeviceId);
const relayTransport = invitation.searchParams.get('transport') === 'webrtc' ? 'webrtc' : 'https';
let linkSession = null;
let relayClient = null;
let pollTimer = 0;
let mediaPollTimer = 0;
let heartbeatTimer = 0;
let polling = false;
let mediaPolling = false;
let heartbeatBusy = false;
let inputBusy = false;
let lastAudioSequence = 0;
let lastSpeakerSequence = 0;
let frameFailures = 0;
let mediaFailures = 0;
let heartbeatFailures = 0;
let audioQueue = [];
let audioPlaying = false;
let audioUnlocked = true;
let audioPlaybackBlocked = false;
let audioMediaAllowed = false;

history.replaceState(null, '', `${location.pathname}?invite=${encodeURIComponent(inviteId)}${relayMode ? `&relay=1&device=${encodeURIComponent(relayDeviceId)}&transport=${encodeURIComponent(relayTransport)}` : ''}`);

function show(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function setControlEnabled(enabled) {
  pointerControls.disabled = !enabled;
  keyboardControls.setAttribute('aria-disabled', String(!enabled));
  keyCapture.tabIndex = enabled ? 0 : -1;
  for (const button of keyboardControls.querySelectorAll('button')) button.disabled = !enabled;
  frame.classList.toggle('interactive', enabled);
}

function endSession(message) {
  linkSession = null;
  const closingRelay = relayClient;
  relayClient = null;
  closingRelay?.close();
  clearTimeout(pollTimer);
  clearTimeout(mediaPollTimer);
  clearTimeout(heartbeatTimer);
  pollTimer = 0;
  mediaPollTimer = 0;
  heartbeatTimer = 0;
  setControlEnabled(false);
  controlBadge.textContent = 'ENDED';
  controlStatus.textContent = message;
  stopButton.disabled = true;
  camera.removeAttribute('src'); camera.hidden = true; mediaPanel.hidden = true;
  audioQueue = []; audioPlaying = false; audioPlaybackBlocked = false; audioMediaAllowed = false; audioEnable.hidden = true;
  agentWorkspace.hidden = true;
  agentOrientation.textContent = '';
  agentActionInput.value = '';
  agentActionResult.textContent = '';
  control.hidden = true;
  show(message, true);
}

function linkFetch(pathname, options) {
  return relayClient ? relayClient.fetch(pathname, options) : fetch(pathname, options);
}

async function signedRequest(pathname, options = {}) {
  return signedLinkRequest(pathname, { ...options, fetchFn: linkFetch });
}

function showAgentAction(actionId) {
  const action = availableAgentLinkActions(linkSession?.capabilities).find((item) => item.id === actionId);
  if (!action) return;
  agentActionInput.value = action.template === null ? '' : JSON.stringify(action.template, null, 2);
  agentActionInput.disabled = action.method === 'GET';
  agentActionStatus.textContent = '';
  agentActionResult.textContent = '';
}

function openAgentWorkspace() {
  const capabilities = linkSession?.capabilities || [];
  const actions = availableAgentLinkActions(capabilities);
  agentCapabilities.textContent = capabilities.length ? `Granted: ${capabilities.join(', ')}` : 'No actions were granted on this link.';
  agentActionSelect.replaceChildren(...actions.map((action) => {
    const option = document.createElement('option');
    option.value = action.id;
    option.textContent = action.label;
    return option;
  }));
  agentActionForm.hidden = actions.length === 0;
  agentWorkspace.hidden = false;
  if (actions.length) showAgentAction(actions[0].id);
}

async function runAgentAction(actionId, input) {
  const session = linkSession;
  if (!session) throw new Error('This agent link is not connected.');
  const prepared = prepareAgentLinkAction(actionId, session.capabilities, input);
  if (agentActionSelect.value === actionId) agentActionInput.value = prepared.input;
  const result = await signedRequest(prepared.action.pathname, {
    token: session.token, method: prepared.action.method, body: prepared.body
  });
  if (linkSession !== session) throw new Error('This agent link has ended.');
  return result;
}

agentActionSelect.addEventListener('change', () => showAgentAction(agentActionSelect.value));
agentActionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  agentActionRun.disabled = true;
  agentActionStatus.textContent = 'Sending…';
  agentActionResult.textContent = '';
  try {
    const result = await runAgentAction(agentActionSelect.value, agentActionInput.value);
    agentActionStatus.textContent = 'Done';
    agentActionResult.textContent = JSON.stringify(result, null, 2).slice(0, 32768);
  } catch (error) {
    if (error.status === 401 || error.status === 410) endSession(error.message);
    else agentActionStatus.textContent = error.message;
  } finally { agentActionRun.disabled = !linkSession; }
});

function schedulePoll(delay = 1200) {
  clearTimeout(pollTimer);
  if (!linkSession) return;
  pollTimer = window.setTimeout(pollFrame, delay);
}

function retryDelay(failures, base = 900, max = 12000) {
  return Math.min(max, Math.round(base * (2 ** Math.min(5, Math.max(0, failures - 1)))) + Math.round(Math.random() * 250));
}

function scheduleHeartbeat(delay = 5000) {
  clearTimeout(heartbeatTimer);
  if (!linkSession?.capabilities.includes('status')) return;
  heartbeatTimer = window.setTimeout(sendHeartbeat, delay);
}

function scheduleMediaPoll(delay = 900) {
  clearTimeout(mediaPollTimer);
  if (!linkSession || (!linkSession.capabilities.includes('camera-view') && !linkSession.capabilities.includes('microphone-listen'))) return;
  mediaPollTimer = window.setTimeout(pollMedia, delay);
}

function applyBridge(bridge = {}) {
  const active = bridge.enabled && bridge.controlGranted && bridge.agentControlActive && linkSession?.capabilities.includes('desktop-control');
  setControlEnabled(Boolean(active));
  controlBadge.textContent = bridge.enabled ? active ? 'CONTROL ACTIVE' : 'VIEW ONLY' : 'WAITING';
  controlStatus.textContent = bridge.enabled
    ? active ? 'The owner approved screen view and computer control.' : bridge.controlGranted ? 'The owner took over. Screen view remains available; input is paused.' : 'Screen view is active. Computer control was not approved.'
    : 'Waiting for the owner to start computer access.';
}

async function drainAudio() {
  if (!audioQueue.length) { audioEnable.hidden = !(audioPlaybackBlocked && audioMediaAllowed); return; }
  if (audioPlaying || !audioUnlocked) { audioEnable.hidden = !(audioPlaybackBlocked && audioMediaAllowed); return; }
  audioPlaying = true;
  const segment = audioQueue.shift();
  const player = new Audio(`data:${segment.mimeType};base64,${segment.data}`);
  try {
    await player.play();
    audioPlaybackBlocked = false;
    audioEnable.hidden = true;
    await new Promise((resolve) => { player.onended = resolve; player.onerror = resolve; });
  } catch {
    audioUnlocked = false;
    audioPlaybackBlocked = true;
    audioQueue.unshift(segment);
    audioEnable.hidden = false;
  } finally {
    audioPlaying = false;
    if (audioUnlocked) void drainAudio();
  }
}

function applyMedia(result = {}) {
  const media = result.media || {};
  const allowed = media.cameraGranted || media.microphoneGranted;
  audioMediaAllowed = media.microphoneGranted === true;
  mediaPanel.hidden = !allowed && !(audioPlaybackBlocked && audioQueue.length);
  const labels = [];
  if (media.cameraGranted) labels.push(media.cameraActive ? 'camera live' : 'camera granted');
  if (media.microphoneGranted) labels.push(media.microphoneActive ? 'microphone live' : 'microphone granted');
  mediaStatus.textContent = labels.join(' · ') || 'Media is not shared';
  if (result.camera?.data) {
    camera.src = `data:${result.camera.mimeType};base64,${result.camera.data}`;
    camera.hidden = false;
  } else if (!media.cameraGranted) { camera.removeAttribute('src'); camera.hidden = true; }
  for (const segment of result.audio || []) {
    if (segment.sequence > lastAudioSequence) { lastAudioSequence = segment.sequence; audioQueue.push(segment); }
  }
  audioEnable.hidden = !(audioPlaybackBlocked && audioMediaAllowed);
  void drainAudio();
}

async function pollMedia() {
  if (!linkSession || mediaPolling || (!linkSession.capabilities.includes('camera-view') && !linkSession.capabilities.includes('microphone-listen'))) return;
  mediaPolling = true;
  try {
    const result = await signedRequest('/agent-link/v1/desktop/media', { token: linkSession.token, method: 'POST', body: { afterAudioSequence: lastAudioSequence } });
    mediaFailures = 0;
    const replay = result.replay?.audio;
    if (replay?.gap) mediaStatus.textContent = 'Reconnected; replay window started after a brief media gap.';
    applyMedia(result);
  } catch (error) {
    if (error.status === 401 || error.status === 410) { endSession(error.message); return; }
    mediaFailures += 1;
    mediaPanel.hidden = false; mediaStatus.textContent = error.message || 'Waiting for owner media permission.';
  } finally {
    mediaPolling = false;
    scheduleMediaPoll(mediaFailures ? retryDelay(mediaFailures, 700) : 900);
  }
}

async function pollFrame() {
  if (!linkSession || polling) return;
  if (document.hidden) return schedulePoll(1200);
  polling = true;
  try {
    const result = await signedRequest('/agent-link/v1/desktop/frame', { token: linkSession.token });
    if (!linkSession) return;
    frame.src = `data:${result.frame?.mimeType || 'image/png'};base64,${result.frame?.data || ''}`;
    frameWrap.hidden = false;
    applyBridge(result.bridge);
    frameFailures = 0;
  } catch (error) {
    if (error.status === 401 || error.status === 410) { endSession(error.message); return; }
    frameFailures += 1;
    setControlEnabled(false);
    controlBadge.textContent = 'WAITING';
    controlStatus.textContent = error.message || 'Computer access is not active yet.';
  } finally {
    polling = false;
    schedulePoll(frameFailures ? retryDelay(frameFailures, 1000) : 1200);
  }
}

async function sendHeartbeat() {
  if (!linkSession || heartbeatBusy) return;
  heartbeatBusy = true;
  try {
    await signedRequest('/agent-link/v1/heartbeat', { token: linkSession.token, method: 'POST', body: { transport: relayMode ? relayTransport : 'https', afterAudioSequence: lastAudioSequence, afterSpeakerSequence: lastSpeakerSequence } });
    heartbeatFailures = 0;
  } catch (error) {
    if (error.status === 401 || error.status === 410) { endSession(error.message); return; }
    heartbeatFailures += 1;
  } finally {
    heartbeatBusy = false;
    scheduleHeartbeat(heartbeatFailures ? retryDelay(heartbeatFailures, 1500, 15000) : 5000);
  }
}

async function sendInput(input) {
  if (!linkSession || inputBusy) return;
  inputBusy = true;
  try {
    const result = await signedRequest('/agent-link/v1/desktop/input', { token: linkSession.token, method: 'POST', body: { input } });
    applyBridge(result.bridge);
  } catch (error) {
    setControlEnabled(false);
    controlStatus.textContent = error.message;
    if (error.status === 401 || error.status === 410) endSession(error.message);
  } finally { inputBusy = false; }
}

function supportedKey(value) {
  if (/^[A-Za-z0-9]$/.test(value)) return value;
  if (value === ' ') return 'Space';
  const allowed = new Set(['Backspace', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Pause', 'CapsLock', 'Escape', 'Space', 'PageUp', 'PageDown', 'End', 'Home', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete', 'Meta', 'ContextMenu', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
  return allowed.has(value) ? value : '';
}

if (!inviteId || !inviteSecret) {
  form.hidden = true;
  show('This invitation is incomplete or its private part is missing. Ask the owner for a new link.', true);
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true; show('Connecting securely…');
  try {
    const pairBody = {
        inviteId, secret: inviteSecret,
        identity: { name: document.querySelector('#linkAgentName').value, framework: document.querySelector('#linkFramework').value, externalId: document.querySelector('#linkExternalId').value, version: 'web-2' },
        capabilities: ['messages', 'status', 'receipts', 'cognition', 'identity', 'desktop-view', 'desktop-control', 'camera-view', 'microphone-listen', 'speaker-output', 'hexispace-profile', 'hexispace-posts', 'hexispace-comments', 'hexispace-friends', 'hexispace-relationships', 'hexispace-reactions']
      };
    let body;
    if (relayMode) {
      relayClient = new AgentRelayClient({ deviceId: relayDeviceId, inviteId, inviteSecret });
      relayClient.addEventListener('closed', (event) => { if (linkSession) endSession(event.detail); });
      relayClient.addEventListener('proof', () => {
        relayDiagnostics.hidden = false;
        relayProofLog.textContent = relayClient.proofLog.map((entry) => `${entry.at} ${entry.event} phase=${entry.phase || '-'} request=${entry.request || '-'} key=${entry.keyId || '-'} envelope=${entry.envelope || '-'} status=${entry.status ?? '-'}${entry.reason ? ` reason=${entry.reason}` : ''}`).join('\n');
      });
      await relayClient.connect();
      body = await relayClient.pair(pairBody);
    } else {
      const response = await fetch('/agent-link/v1/pair', {
        method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(pairBody)
      });
      body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'The connection failed.');
    }
    linkSession = { token: body.token, connectionId: body.connection.id, capabilities: body.connection.capabilities || [] };
    agentOrientation.textContent = JSON.stringify(body.orientation || {}, null, 2);
    form.hidden = true;
    show(`Connected as ${body.connection.identity?.name || 'remote agent'}. The credential remains only in this tab.`);
    openAgentWorkspace();
    if (linkSession.capabilities.includes('desktop-view')) {
      control.hidden = false;
      stopButton.disabled = false;
      applyBridge({ enabled: false });
      schedulePoll(0);
      scheduleMediaPoll(0);
    }
    scheduleHeartbeat(0);
  } catch (error) { show(error.message, true); button.disabled = false; }
});

frame.addEventListener('click', async (event) => {
  if (pointerControls.disabled || !linkSession || inputBusy || !frame.naturalWidth || !frame.naturalHeight) return;
  const rect = frame.getBoundingClientRect();
  const x = Math.max(0, Math.min(frame.naturalWidth - 1, Math.round((event.clientX - rect.left) * frame.naturalWidth / rect.width)));
  const y = Math.max(0, Math.min(frame.naturalHeight - 1, Math.round((event.clientY - rect.top) * frame.naturalHeight / rect.height)));
  const action = document.querySelector('input[name="pointerAction"]:checked')?.value || 'left';
  await sendInput({ kind: 'mouse.move', x, y });
  if (action !== 'move' && linkSession) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await sendInput({ kind: 'mouse.click', button: action });
  }
});

keyCapture.addEventListener('keydown', async (event) => {
  const key = supportedKey(event.key);
  if (!key || keyboardControls.getAttribute('aria-disabled') === 'true') return;
  event.preventDefault();
  await sendInput({ kind: 'key.press', key });
});

keyboardControls.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-desktop-key]');
  if (!button || button.disabled) return;
  await sendInput({ kind: 'key.press', key: button.dataset.desktopKey });
});

stopButton.addEventListener('click', async () => {
  if (!linkSession) return;
  stopButton.disabled = true;
  try {
    const result = await signedRequest('/agent-link/v1/desktop/stop', { token: linkSession.token, method: 'POST', body: {} });
    applyBridge(result.bridge);
    controlStatus.textContent = 'You stopped this computer-access session. The owner may deliberately start it again for this Link.';
  } catch (error) {
    controlStatus.textContent = error.message;
    if (error.status === 401 || error.status === 410) endSession(error.message);
  } finally { if (linkSession) stopButton.disabled = false; }
});

audioEnable.addEventListener('click', () => { audioEnable.disabled = true; audioUnlocked = true; audioPlaybackBlocked = false; audioEnable.hidden = true; void drainAudio().finally(() => { audioEnable.disabled = false; }); });

async function readOwnerMedia(afterAudioSequence = lastAudioSequence) {
  if (!linkSession) throw new Error('This agent link is not connected.');
  const result = await signedRequest('/agent-link/v1/desktop/media', { token: linkSession.token, method: 'POST', body: { afterAudioSequence, freshCamera: linkSession.capabilities.includes('camera-view') } });
  applyMedia(result);
  return result;
}

async function sendSpeakerAudio({ mimeType, data, durationMs = 1000 } = {}) {
  if (!linkSession) throw new Error('This agent link is not connected.');
  if (!linkSession.capabilities.includes('speaker-output')) throw new Error('This agent link was not granted speaker output.');
  return signedRequest('/agent-link/v1/desktop/speaker', { token: linkSession.token, method: 'POST', body: { mimeType, data, durationMs } });
}

window.HexiGridAgentBridge = Object.freeze({ readOwnerMedia, sendSpeakerAudio,
  actions: () => availableAgentLinkActions(linkSession?.capabilities).map(({ id, label, capability }) => ({ id, label, capability })),
  runAction: runAgentAction
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) { schedulePoll(0); scheduleMediaPoll(0); scheduleHeartbeat(0); } });
window.addEventListener('pagehide', () => { linkSession = null; relayClient?.close(); relayClient = null; clearTimeout(pollTimer); clearTimeout(mediaPollTimer); clearTimeout(heartbeatTimer); });
