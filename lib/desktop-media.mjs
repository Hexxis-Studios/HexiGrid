import { captureLocalCamera as captureNativeCamera } from './local-camera.mjs';
const MAX_CAMERA_BYTES = 220 * 1024;
const MAX_CAMERA_FRAMES = 8;
const MAX_CAMERA_WIDTH = 640;
const MAX_CAMERA_HEIGHT = 480;
const MAX_AUDIO_BYTES = 700 * 1024;
const MAX_AUDIO_CHUNKS = 12;
const MAX_SPEAKER_BYTES = 700 * 1024;
const MAX_SPEAKER_CHUNKS = 12;
let cameraQueue = Promise.resolve();
function captureLocalCamera(options) {
  const pending = cameraQueue.then(() => { if (options?.signal?.aborted) throw options.signal.reason || new Error('Camera capture cancelled.'); return captureNativeCamera(options); });
  cameraQueue = pending.catch(() => {});
  return pending;
}
function createMediaSession() {
let ownerPausedLinkId = '';
const ownerPausedKinds = new Set();

const replayWindow = (items, afterSequence, nextSequence) => {
  const requested = Math.max(0, Number(afterSequence) || 0);
  const oldest = items.length ? items[0].sequence : nextSequence;
  return {
    requestedAfter: requested,
    oldestAvailable: oldest,
    latest: Math.max(0, nextSequence - 1),
    complete: requested >= oldest - 1,
    gap: requested < oldest - 1
  };
};

const blank = (reason = 'not-started') => ({
  linkId: '', cameraPermitted: false, cameraGranted: false, microphoneGranted: false, speakerGranted: false,
  cameraActive: false, microphoneActive: false, speakerActive: false, camera: null, cameraFrames: [],
  audio: [], speaker: [], nextCameraSequence: 1, nextAudioSequence: 1, nextSpeakerSequence: 1,
  startedAt: null, updatedAt: null, stopReason: reason
});

let session = blank();
let cameraCapture = null;
let cameraGeneration = 0;
const microphoneWaiters = new Map();
const cameraWaiters = new Set();
const OWNER_PAUSE_REASONS = new Set(['owner-media-stop', 'owner-media-off', 'owner-camera-off', 'owner-stop', 'owner-takeover', 'emergency-stop']);
const mediaKindFlag = { camera: 'cameraGranted', microphone: 'microphoneGranted', speaker: 'speakerGranted' };
function rememberOwnerPause(linkId, kind, paused) {
  const id = String(linkId || '');
  if (!id || !['camera', 'microphone', 'speaker'].includes(kind)) return;
  if (paused) {
    if (ownerPausedLinkId !== id) ownerPausedKinds.clear();
    ownerPausedLinkId = id;
    ownerPausedKinds.add(kind);
  } else if (ownerPausedLinkId === id) {
    ownerPausedKinds.delete(kind);
    if (!ownerPausedKinds.size) ownerPausedLinkId = '';
  }
}
function desktopMediaKindOwnerPaused(linkId, kind) {
  return ownerPausedLinkId === String(linkId || '') && ownerPausedKinds.has(kind);
}
function cancelCameraCapture() { cameraGeneration++; cameraCapture?.controller.abort(); cameraCapture = null; for (const wake of [...cameraWaiters]) wake(); }
function wakeMicrophoneWaiters(linkId) {
  const waiters = microphoneWaiters.get(String(linkId || ''));
  if (!waiters) return;
  for (const wake of [...waiters]) wake();
}
const now = () => new Date().toISOString();
const cleanMime = (value, allowed) => allowed.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : '';
const decodedSize = (value) => Math.ceil(String(value || '').length * 3 / 4);

function startDesktopMedia({ linkId, cameraGranted = false, microphoneGranted = false, speakerGranted = false, ownerPausedMediaKinds = [], preserveSequences = false, sequenceFloor = {} } = {}) {
  const cursors = { nextCameraSequence: session.nextCameraSequence, nextAudioSequence: session.nextAudioSequence, nextSpeakerSequence: session.nextSpeakerSequence };
  wakeMicrophoneWaiters(session.linkId);
  cancelCameraCapture();
  ownerPausedLinkId = '';
  ownerPausedKinds.clear();
  session = { ...blank(''), linkId: String(linkId || ''), cameraPermitted: cameraGranted === true, cameraGranted: cameraGranted === true, microphoneGranted: microphoneGranted === true, speakerGranted: speakerGranted === true, startedAt: now(), updatedAt: now() };
  if (preserveSequences) for (const key of Object.keys(cursors)) session[key] = Math.max(cursors[key], sequenceFloor[key] || 1);
  for (const kind of ownerPausedMediaKinds) rememberOwnerPause(session.linkId, kind, true);
  return publicDesktopMedia();
}

function stopDesktopMedia(reason = 'owner-stop') {
  cancelCameraCapture(); wakeMicrophoneWaiters(session.linkId);
  if (OWNER_PAUSE_REASONS.has(reason)) for (const kind of Object.keys(mediaKindFlag)) rememberOwnerPause(session.linkId, kind, true);
  session = blank(String(reason).slice(0, 80)); return publicDesktopMedia();
}

function stopDesktopMediaKind(kind, reason = 'owner-stop') {
  if (kind === 'all') return stopDesktopMedia(reason);
  if (kind === 'camera') {
    cancelCameraCapture();
    session.cameraGranted = false;
    session.cameraActive = false;
    session.camera = null;
    session.cameraFrames = [];
  } else if (kind === 'microphone') {
    wakeMicrophoneWaiters(session.linkId);
    session.microphoneGranted = false;
    session.microphoneActive = false;
    session.audio = [];
  } else if (kind === 'speaker') {
    session.speakerGranted = false;
    session.speakerActive = false;
    session.speaker = [];
  } else {
    throw Object.assign(new Error('Choose camera, microphone, speaker, or all.'), { status: 400 });
  }
  if (OWNER_PAUSE_REASONS.has(reason)) rememberOwnerPause(session.linkId, kind, true);
  session.updatedAt = now();
  session.stopReason = String(reason).slice(0, 80);
  return publicDesktopMedia();
}

/** Stop a live device stream while preserving its approved grant. */
function pauseDesktopMediaKind(kind, reason = 'media-paused') {
  if (kind === 'all') {
    for (const mediaKind of Object.keys(mediaKindFlag)) pauseDesktopMediaKind(mediaKind, reason);
    return publicDesktopMedia();
  }
  if (!['camera', 'microphone', 'speaker'].includes(kind)) throw Object.assign(new Error('Choose camera, microphone, speaker, or all.'), { status: 400 });
  if (kind === 'camera') {
    cancelCameraCapture();
    session.cameraActive = false;
    session.camera = null;
    session.cameraFrames = [];
  } else if (kind === 'microphone') {
    wakeMicrophoneWaiters(session.linkId);
    session.microphoneActive = false;
    session.audio = [];
  } else {
    session.speakerActive = false;
    session.speaker = [];
  }
  session.updatedAt = now();
  session.stopReason = String(reason).slice(0, 80);
  return publicDesktopMedia();
}

function setDesktopMediaKind(linkId, kind, enabled, { source = 'owner' } = {}) {
  if (!['camera', 'microphone', 'speaker'].includes(kind) || typeof enabled !== 'boolean') throw Object.assign(new Error('Choose one media switch and an explicit on/off state.'), { status: 400 });
  if (!session.linkId && !enabled) return publicDesktopMedia();
  if (!session.linkId && enabled && source === 'agent-policy' && desktopMediaKindOwnerPaused(linkId, kind)) {
    throw Object.assign(new Error(`The owner paused ${kind} for this session; the owner must resume it first.`), { status: 403 });
  }
  if (!session.linkId && enabled) session = { ...blank(''), linkId: String(linkId), startedAt: now() };
  if (session.linkId !== String(linkId)) throw Object.assign(new Error('Media is not active for this Hexonaut.'), { status: 409 });
  if (!enabled) return stopDesktopMediaKind(kind, 'owner-media-off');
  if (source === 'agent-policy' && desktopMediaKindOwnerPaused(linkId, kind)) {
    throw Object.assign(new Error(`The owner paused ${kind} for this session; the owner must resume it first.`), { status: 403 });
  }
  if (source !== 'agent-policy') rememberOwnerPause(linkId, kind, false);
  if (kind === 'camera') { cancelCameraCapture(); session.cameraPermitted = true; session.cameraGranted = true; session.cameraActive = false; session.camera = null; session.cameraFrames = []; }
  if (kind === 'microphone') { session.microphoneGranted = true; session.microphoneActive = false; session.audio = []; }
  if (kind === 'speaker') { session.speakerGranted = true; session.speakerActive = false; session.speaker = []; }
  session.updatedAt = now();
  session.stopReason = '';
  return publicDesktopMedia();
}

function clearDesktopSpeaker(linkId) {
  if (!session.linkId || session.linkId !== String(linkId)) throw Object.assign(new Error('Speaker output is not active for this Hexonaut.'), { status: 409 });
  session.speaker = [];
  session.speakerActive = false;
  wakeMicrophoneWaiters(linkId);
  session.updatedAt = now();
  return publicDesktopMedia();
}

/** Drop owner microphone segments captured before the exact call began. */
function clearDesktopMicrophone(linkId) {
  if (!session.linkId || session.linkId !== String(linkId)) throw Object.assign(new Error('Microphone media is not active for this Hexonaut.'), { status: 409 });
  session.audio = [];
  session.microphoneActive = false;
  session.updatedAt = now();
  wakeMicrophoneWaiters(linkId);
  return publicDesktopMedia();
}

function nextDesktopMicrophoneSequence(linkId) {
  if (session.linkId !== String(linkId)) throw Object.assign(new Error('Microphone media is not active for this Hexonaut.'), { status: 409 });
  return session.nextAudioSequence;
}

function pauseDesktopAudio(linkId, reason = 'presence-receded') {
  if (!session.linkId || session.linkId !== String(linkId)) return publicDesktopMedia();
  wakeMicrophoneWaiters(linkId);
  session.microphoneActive = false;
  session.speakerActive = false;
  session.audio = [];
  session.speaker = [];
  session.updatedAt = now();
  session.stopReason = String(reason).slice(0, 80);
  return publicDesktopMedia();
}

function publicDesktopMedia() {
  return {
    linkId: session.linkId, cameraGranted: session.cameraGranted, microphoneGranted: session.microphoneGranted, speakerGranted: session.speakerGranted,
    cameraActive: session.cameraActive, microphoneActive: session.microphoneActive, speakerActive: session.speakerActive,
    cameraCanResume: session.cameraPermitted,
    startedAt: session.startedAt, updatedAt: session.updatedAt, stopReason: session.stopReason
  };
}

function setDesktopCameraEnabled(linkId, enabled) {
  if (!session.linkId || session.linkId !== String(linkId) || !session.cameraPermitted) throw Object.assign(new Error('Camera was not granted for this computer-access session.'), { status: 403 });
  cancelCameraCapture();
  session.cameraGranted = enabled === true;
  session.cameraActive = false;
  session.camera = null;
  session.cameraFrames = [];
  session.updatedAt = now();
  rememberOwnerPause(linkId, 'camera', !enabled);
  session.stopReason = enabled === true ? '' : 'owner-camera-off';
  return publicDesktopMedia();
}

function publishCameraFrame(linkId, { mimeType, data, width, height } = {}, source = 'browser') {
  if (!session.linkId || session.linkId !== String(linkId) || !session.cameraGranted) throw Object.assign(new Error('Camera is not granted for this computer-access session.'), { status: 403 });
  const mime = cleanMime(mimeType, ['image/jpeg', 'image/webp']);
  const frameWidth = Math.max(1, Math.min(MAX_CAMERA_WIDTH, Number(width) || 480));
  const frameHeight = Math.max(1, Math.min(MAX_CAMERA_HEIGHT, Number(height) || 270));
  if (!mime || typeof data !== 'string' || !data || decodedSize(data) > MAX_CAMERA_BYTES) throw Object.assign(new Error('Camera frame is invalid or too large.'), { status: 400 });
  const sequence = session.nextCameraSequence++;
  const capturedAt = now();
  const frame = { sequence, mimeType: mime, data, width: frameWidth, height: frameHeight, capturedAt };
  session.camera = frame;
  session.cameraSource = source;
  session.cameraFrames.push(frame);
  session.cameraFrames = session.cameraFrames.slice(-MAX_CAMERA_FRAMES);
  session.cameraActive = true; session.updatedAt = capturedAt;
  for (const wake of [...cameraWaiters]) wake();
  return { media: publicDesktopMedia(), capturedAt, sequence };
}

function publishMicrophoneChunk(linkId, { mimeType, data, durationMs, speechActive } = {}) {
  if (!session.linkId || session.linkId !== String(linkId) || !session.microphoneGranted) throw Object.assign(new Error('Microphone is not granted for this computer-access session.'), { status: 403 });
  const mime = cleanMime(mimeType, ['audio/webm', 'audio/ogg', 'audio/mp4']);
  const duration = Math.max(100, Math.min(2500, Number(durationMs) || 1000));
  if (!mime || typeof data !== 'string' || !data || decodedSize(data) > MAX_AUDIO_BYTES) throw Object.assign(new Error('Microphone segment is invalid or too large.'), { status: 400 });
  const sequence = session.nextAudioSequence++; const capturedAt = now();
  session.audio.push({ sequence, mimeType: mime, data, durationMs: duration, capturedAt,
    ...(typeof speechActive === 'boolean' ? { speechActive } : {}) });
  session.audio = session.audio.slice(-MAX_AUDIO_CHUNKS); session.microphoneActive = true; session.updatedAt = capturedAt;
  wakeMicrophoneWaiters(linkId);
  return { media: publicDesktopMedia(), sequence };
}

function publishSpeakerChunk(linkId, { mimeType, data, durationMs } = {}) {
  if (!session.linkId || session.linkId !== String(linkId) || !session.speakerGranted) throw Object.assign(new Error('Speaker output is not granted for this computer-access session.'), { status: 403 });
  const mime = cleanMime(mimeType, ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);
  const duration = Math.max(100, Math.min(2500, Number(durationMs) || 1000));
  if (!mime || typeof data !== 'string' || !data || decodedSize(data) > MAX_SPEAKER_BYTES) throw Object.assign(new Error('Speaker audio is invalid or too large.'), { status: 400 });
  const sequence = session.nextSpeakerSequence++; const capturedAt = now();
  session.speaker.push({ sequence, mimeType: mime, data, durationMs: duration, capturedAt });
  session.speaker = session.speaker.slice(-MAX_SPEAKER_CHUNKS); session.speakerActive = true; session.updatedAt = capturedAt;
  return { media: publicDesktopMedia(), sequence };
}

function readDesktopMedia(linkId, capabilities = [], afterAudioSequence = 0, afterSpeakerSequence = 0, afterCameraSequence = 0) {
  if (!session.linkId || session.linkId !== String(linkId)) throw Object.assign(new Error('Media is not active for this Hexonaut.'), { status: 409 });
  const cameraAllowed = session.cameraGranted && capabilities.includes('camera-view');
  const microphoneAllowed = session.microphoneGranted && capabilities.includes('microphone-listen');
  const speakerAllowed = session.speakerGranted && capabilities.includes('speaker-output');
  const audioReplay = replayWindow(session.audio, afterAudioSequence, session.nextAudioSequence);
  const speakerReplay = replayWindow(session.speaker, afterSpeakerSequence, session.nextSpeakerSequence);
  const cameraReplay = replayWindow(session.cameraFrames, afterCameraSequence, session.nextCameraSequence);
  return {
    media: { ...publicDesktopMedia(), cameraGranted: cameraAllowed, microphoneGranted: microphoneAllowed, speakerGranted: speakerAllowed, cameraActive: cameraAllowed && session.cameraActive, microphoneActive: microphoneAllowed && session.microphoneActive, speakerActive: speakerAllowed && session.speakerActive },
    camera: cameraAllowed ? session.camera : null,
    video: cameraAllowed ? session.cameraFrames.filter((item) => item.sequence > Number(afterCameraSequence || 0)) : [],
    audio: microphoneAllowed ? session.audio.filter((item) => item.sequence > Number(afterAudioSequence || 0)) : [],
    speaker: speakerAllowed ? session.speaker.filter((item) => item.sequence > Number(afterSpeakerSequence || 0)) : [],
    replay: { camera: cameraAllowed ? cameraReplay : null, audio: microphoneAllowed ? audioReplay : null, speaker: speakerAllowed ? speakerReplay : null }
  };
}

function readDesktopSpeaker(linkId, afterSpeakerSequence = 0) {
  if (!session.linkId || session.linkId !== String(linkId)) throw Object.assign(new Error('Speaker output is not active for this Hexonaut.'), { status: 409 });
  return { media: publicDesktopMedia(), speaker: session.speaker.filter((item) => item.sequence > Number(afterSpeakerSequence || 0)), replay: { speaker: replayWindow(session.speaker, afterSpeakerSequence, session.nextSpeakerSequence) } };
}

/** Read only microphone audio for the exact active Link; camera and speaker bytes are never included. */
function readDesktopMicrophone(linkId, afterAudioSequence = 0) {
  if (!session.linkId || session.linkId !== String(linkId)) throw Object.assign(new Error('Media is not active for this Hexonaut.'), { status: 409 });
  if (!session.microphoneGranted) throw Object.assign(new Error('Microphone listening is not granted for this computer-access session.'), { status: 403 });
  const replay = replayWindow(session.audio, afterAudioSequence, session.nextAudioSequence);
  return {
    media: { linkId: session.linkId, microphoneGranted: session.microphoneGranted,
      microphoneActive: session.microphoneActive, updatedAt: session.updatedAt, stopReason: session.stopReason },
    audio: session.audio.filter((item) => item.sequence > Number(afterAudioSequence || 0)).slice(0, 3),
    replay
  };
}

/** Wait for an uploaded owner microphone segment without tight polling. The wait is bounded and abortable. */
async function waitForDesktopMicrophone(linkId, afterAudioSequence = 0, { waitMs = 8000, signal } = {}) {
  const initial = readDesktopMicrophone(linkId, afterAudioSequence);
  if (initial.audio.length || signal?.aborted || Number(waitMs) <= 0) return initial;
  let waiters = microphoneWaiters.get(String(linkId));
  if (!waiters) { waiters = new Set(); microphoneWaiters.set(String(linkId), waiters); }
  let wake;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waiters.delete(wake);
        if (!waiters.size && microphoneWaiters.get(String(linkId)) === waiters) microphoneWaiters.delete(String(linkId));
        error ? reject(error) : resolve();
      };
      wake = () => finish();
      const onAbort = () => finish(signal.reason || Object.assign(new Error('Microphone wait aborted.'), { name: 'AbortError' }));
      const timer = setTimeout(() => finish(), Math.max(0, Math.min(10_000, Number(waitMs) || 0)));
      waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (readDesktopMicrophone(linkId, afterAudioSequence).audio.length) finish();
    });
  } finally {
    if (!waiters.size && microphoneWaiters.get(String(linkId)) === waiters) microphoneWaiters.delete(String(linkId));
  }
  return readDesktopMicrophone(linkId, afterAudioSequence);
}

// Authority is checked before capture and again after asynchronous device work.
// A paused/revoked camera aborts only this owned capture process and invalidates
// its generation, even if it is re-enabled before the old process finishes.
async function ensureAgentCamera(linkId, authorize, { capture = captureLocalCamera, afterCameraSequence = 0, fresh = false } = {}) {
  authorize();
  if (!session.linkId) setDesktopMediaKind(linkId, 'camera', true, { source: 'agent-policy' });
  if (session.linkId !== linkId) throw Object.assign(new Error('Media belongs to a different Hexonaut.'), { status: 409 });
  if (!session.cameraGranted) throw Object.assign(new Error('Camera capture is paused. Re-enable camera-view through capabilities-set or the owner media switch.'), { status: 403 });
  const minimumSequence = Math.max(Number(afterCameraSequence || 0), fresh ? session.camera?.sequence || 0 : 0);
  if (!fresh && session.camera && Date.now() - Date.parse(session.camera.capturedAt) < 1000 && session.camera.sequence > minimumSequence) return;
  if (fresh && session.cameraSource === 'browser' && session.cameraActive && Date.now() - Date.parse(session.camera?.capturedAt) < 2000) {
    const generation = cameraGeneration;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('The camera stream did not provide a fresh frame. No cached image was returned.')), 2500);
      const finish = error => { clearTimeout(timer); cameraWaiters.delete(wake); error ? reject(Object.assign(error, { status: 409 })) : resolve(); };
      const wake = () => {
        if (generation !== cameraGeneration || session.linkId !== linkId || !session.cameraGranted) finish(new Error('Camera access changed before a fresh frame arrived.'));
        else if (session.camera?.sequence > minimumSequence) finish();
      };
      cameraWaiters.add(wake); wake();
    });
    authorize(); return;
  }
  if (cameraCapture) { await cameraCapture.promise; authorize(); if (session.camera?.sequence > minimumSequence) return; }
  const generation = cameraGeneration;
  const controller = new AbortController();
  const pending = { controller, promise: null };
  cameraCapture = pending;
  pending.promise = (async () => {
    const frame = await capture({ signal: controller.signal });
    authorize();
    if (controller.signal.aborted || generation !== cameraGeneration || session.linkId !== linkId || !session.cameraGranted) throw Object.assign(new Error('Camera access changed during capture.'), { status: 403 });
    publishCameraFrame(linkId, frame, 'native');
  })();
  try { await pending.promise; } finally { if (cameraCapture === pending) cameraCapture = null; }
}

function resetDesktopMediaForTests() { stopDesktopMedia('test-reset'); ownerPausedLinkId = ''; ownerPausedKinds.clear(); }

return { sequenceState: () => ({nextCameraSequence: session.nextCameraSequence, nextAudioSequence: session.nextAudioSequence, nextSpeakerSequence: session.nextSpeakerSequence}), startDesktopMedia, stopDesktopMedia, stopDesktopMediaKind, pauseDesktopMediaKind, setDesktopMediaKind, clearDesktopSpeaker, clearDesktopMicrophone, nextDesktopMicrophoneSequence, pauseDesktopAudio, publicDesktopMedia, setDesktopCameraEnabled, publishCameraFrame, publishMicrophoneChunk, publishSpeakerChunk, readDesktopMedia, readDesktopSpeaker, readDesktopMicrophone, waitForDesktopMicrophone, ensureAgentCamera, resetDesktopMediaForTests, desktopMediaKindOwnerPaused };
}

// Each approved Link owns its buffers and device pauses. Audio is never broadcast.
const sessions = new Map();
let selectedLinkId = '';
const inactive = createMediaSession();
function forLink(linkId = selectedLinkId) {
  const id = String(linkId || '');
  if (!id) return inactive;
  if (!sessions.has(id)) sessions.set(id, createMediaSession());
  return sessions.get(id);
}
export function startDesktopMedia(options = {}) {
  const sequenceFloor = forLink().sequenceState();
  selectedLinkId = String(options.linkId || '');
  return forLink(selectedLinkId).startDesktopMedia({...options, sequenceFloor});
}
export function stopDesktopMedia(reason = 'owner-stop', linkId = '') {
  if (linkId) {
    forLink(linkId).stopDesktopMedia(reason);
    if (selectedLinkId === linkId) selectedLinkId = [...sessions].find(([, item]) => item.publicDesktopMedia().linkId)?.[0] || '';
    return publicDesktopMedia(linkId);
  }
  for (const item of sessions.values()) item.stopDesktopMedia(reason);
  selectedLinkId = '';
  return inactive.stopDesktopMedia(reason);
}
export function publicDesktopMedia(linkId = selectedLinkId) { return forLink(linkId).publicDesktopMedia(); }
export function stopDesktopMediaKind(kind, reason, linkId = selectedLinkId) { return forLink(linkId).stopDesktopMediaKind(kind, reason); }
export function pauseDesktopMediaKind(kind, reason, linkId = selectedLinkId) { return forLink(linkId).pauseDesktopMediaKind(kind, reason); }
export function publishCameraFrame(linkId, frame, source = 'browser') {
  const result = forLink(linkId).publishCameraFrame(linkId, frame, source);
  // The owner camera is one device. Fan out only to sessions where its camera
  // was explicitly enabled; recipient authorization is rechecked on each read.
  if (source === 'browser') for (const [id, item] of sessions) {
    if (id !== linkId && item.publicDesktopMedia().cameraGranted) item.publishCameraFrame(id, frame, source);
  }
  return result;
}
export function resetDesktopMediaForTests() {
  for (const item of sessions.values()) item.resetDesktopMediaForTests();
  sessions.clear(); selectedLinkId = ''; inactive.resetDesktopMediaForTests();
}
export function setDesktopMediaKind(linkId, ...args) {
  if (selectedLinkId && selectedLinkId !== linkId && forLink(linkId).publicDesktopMedia().linkId !== linkId) throw Object.assign(new Error('Media is not active for this Hexonaut.'), {status: 409});
  if (!selectedLinkId) selectedLinkId = String(linkId);
  return forLink(linkId).setDesktopMediaKind(linkId, ...args);
}
export function clearDesktopSpeaker(linkId, ...args) { return forLink(linkId).clearDesktopSpeaker(linkId, ...args); }
export function clearDesktopMicrophone(linkId, ...args) { return forLink(linkId).clearDesktopMicrophone(linkId, ...args); }
export function nextDesktopMicrophoneSequence(linkId, ...args) { return forLink(linkId).nextDesktopMicrophoneSequence(linkId, ...args); }
export function pauseDesktopAudio(linkId, ...args) { return forLink(linkId).pauseDesktopAudio(linkId, ...args); }
export function setDesktopCameraEnabled(linkId, ...args) { return forLink(linkId).setDesktopCameraEnabled(linkId, ...args); }
export function publishMicrophoneChunk(linkId, ...args) { return forLink(linkId).publishMicrophoneChunk(linkId, ...args); }
export function publishSpeakerChunk(linkId, ...args) { return forLink(linkId).publishSpeakerChunk(linkId, ...args); }
export function readDesktopMedia(linkId, ...args) { return forLink(linkId).readDesktopMedia(linkId, ...args); }
export function readDesktopSpeaker(linkId, ...args) { return forLink(linkId).readDesktopSpeaker(linkId, ...args); }
export function readDesktopMicrophone(linkId, ...args) { return forLink(linkId).readDesktopMicrophone(linkId, ...args); }
export function waitForDesktopMicrophone(linkId, ...args) { return forLink(linkId).waitForDesktopMicrophone(linkId, ...args); }
export function ensureAgentCamera(linkId, ...args) { if (!selectedLinkId) selectedLinkId = String(linkId); return forLink(linkId).ensureAgentCamera(linkId, ...args); }
export function desktopMediaKindOwnerPaused(linkId, ...args) { return forLink(linkId).desktopMediaKindOwnerPaused(linkId, ...args); }
