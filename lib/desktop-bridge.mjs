import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { clearBrowserDesktopFrame, readBrowserDesktopFrame } from './desktop-screen.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(ROOT, '..', 'scripts');
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_COORDINATE = 100000;
const MAX_TYPED_CHARACTERS = 1000;
const MAX_UIA_CONTROLS = 128;
const MAX_UIA_RESPONSE_BYTES = 16 * 1024;
const UIA_TARGET_TTL_MS = 30_000;
const desktopRate = new Map();
const desktopUiaTargets = new Map();
const KEY_CODES = Object.freeze({
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20,
  Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38,
  ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120,
  F10: 121, F11: 122, F12: 123, Win: 91
});

export const DESKTOP_CAPABILITIES = Object.freeze(['desktop-view', 'desktop-control', 'desktop-type']);

const timestamp = () => new Date().toISOString();
const cleanId = (value) => typeof value === 'string' ? value.trim().slice(0, 160) : '';

export function defaultDesktopBridge() {
  return {
    version: 1,
    enabled: false,
    linkId: '',
    viewGranted: false,
    controlGranted: false,
    textGranted: false,
    ownerApproved: false,
    // These are durable authorizations, not active device streams. Runtime
    // capture and playback always start off after a process restart.
    mediaGrants: { camera: false, microphone: false, speaker: false },
    mediaPausedByOwner: { camera: false, microphone: false, speaker: false },
    agentControlActive: false,
    startedAt: null,
    stoppedAt: null,
    takeoverAt: null,
    lastActionAt: null,
    lastFrameAt: null
  };
}

export function normalizeDesktopBridge(value) {
  const defaults = defaultDesktopBridge();
  const source = value && typeof value === 'object' ? value : {};
  const viewGranted = source.viewGranted === true;
  const controlGranted = viewGranted && source.controlGranted === true;
  const textGranted = controlGranted && source.textGranted === true;
  const enabled = source.enabled === true && Boolean(cleanId(source.linkId)) && viewGranted;
  return {
    ...defaults,
    ...source,
    version: 1,
    enabled,
    linkId: enabled ? cleanId(source.linkId) : '',
    viewGranted: enabled && viewGranted,
    controlGranted: enabled && controlGranted,
    textGranted: enabled && textGranted,
    ownerApproved: enabled && source.ownerApproved === true,
    mediaGrants: {
      camera: enabled && source.ownerApproved === true && source.mediaGrants?.camera === true,
      microphone: enabled && source.ownerApproved === true && source.mediaGrants?.microphone === true,
      speaker: enabled && source.ownerApproved === true && source.mediaGrants?.speaker === true
    },
    mediaPausedByOwner: {
      camera: enabled && source.ownerApproved === true && source.mediaPausedByOwner?.camera === true,
      microphone: enabled && source.ownerApproved === true && source.mediaPausedByOwner?.microphone === true,
      speaker: enabled && source.ownerApproved === true && source.mediaPausedByOwner?.speaker === true
    },
    agentControlActive: enabled && controlGranted && source.agentControlActive !== false,
    startedAt: typeof source.startedAt === 'string' ? source.startedAt.slice(0, 40) : null,
    stoppedAt: typeof source.stoppedAt === 'string' ? source.stoppedAt.slice(0, 40) : null,
    takeoverAt: typeof source.takeoverAt === 'string' ? source.takeoverAt.slice(0, 40) : null,
    lastActionAt: typeof source.lastActionAt === 'string' ? source.lastActionAt.slice(0, 40) : null,
    lastFrameAt: typeof source.lastFrameAt === 'string' ? source.lastFrameAt.slice(0, 40) : null
  };
}

/**
 * One-time migration for bridge state written before media grants were durable.
 * Treat the saved, owner-approved Link scopes as the authorization source; this
 * restores grants only and never starts capture or playback.
 */
export function legacyDesktopMediaGrants(bridge, link) {
  if (!bridge || typeof bridge !== 'object' || Object.hasOwn(bridge, 'mediaGrants')) return null;
  if (bridge.enabled !== true || bridge.ownerApproved !== true || bridge.viewGranted !== true) return null;
  if (!link || link.id !== bridge.linkId || link.status !== 'connected') return null;
  const effective = new Set(Array.isArray(link.capabilities) ? link.capabilities : []);
  const policy = new Set(link.trustLevel === 'owner'
    ? (Array.isArray(link.ownerGrantedCapabilities) ? link.ownerGrantedCapabilities : link.capabilities || [])
    : link.capabilities || []);
  return {
    camera: effective.has('camera-view') && policy.has('camera-view'),
    microphone: effective.has('microphone-listen') && policy.has('microphone-listen'),
    speaker: effective.has('speaker-output') && policy.has('speaker-output')
  };
}

export function publicDesktopBridge(value, { platform = process.platform } = {}) {
  const bridge = normalizeDesktopBridge(value);
  return {
    ...bridge,
    platform,
    supported: platform === 'win32',
    supports: { view: platform === 'win32', control: platform === 'win32', typing: platform === 'win32', scroll: platform === 'win32' },
    message: platform === 'win32'
      ? (bridge.enabled ? (bridge.agentControlActive ? 'The selected Hexonaut can use the granted computer tools.' : 'The bridge is paused for agent control; you have the computer.') : 'Computer access is off until you grant it to a connected Hexonaut.')
      : 'This computer platform is not supported by the first native desktop bridge build.'
  };
}

export function startDesktopBridge(value, { linkId, viewGranted = true, controlGranted = false, textGranted = false, cameraGranted = false, microphoneGranted = false, speakerGranted = false } = {}) {
  const id = cleanId(linkId);
  if (!id) throw new Error('Choose a connected Hexonaut before starting computer access.');
  if (viewGranted !== true) throw new Error('Computer access needs the screen-view permission.');
  if (controlGranted === true && viewGranted !== true) throw new Error('Computer control cannot be granted without screen view.');
  if (textGranted === true && controlGranted !== true) throw new Error('Text input cannot be granted without computer control.');
  clearDesktopUiaTargets();
  clearBrowserDesktopFrame();
  const now = timestamp();
  return {
    ...defaultDesktopBridge(),
    version: 1,
    enabled: true,
    linkId: id,
    viewGranted: true,
    controlGranted: controlGranted === true,
    textGranted: textGranted === true,
    ownerApproved: true,
    mediaGrants: { camera: cameraGranted === true, microphone: microphoneGranted === true, speaker: speakerGranted === true },
    mediaPausedByOwner: { camera: false, microphone: false, speaker: false },
    agentControlActive: controlGranted === true,
    startedAt: now,
    lastActionAt: now
  };
}

export function stopDesktopBridge(value, reason = 'owner-stop') {
  const current = normalizeDesktopBridge(value);
  clearBrowserDesktopFrame();
  clearDesktopUiaTargets();
  return { ...defaultDesktopBridge(), version: 1, stoppedAt: timestamp(), lastActionAt: timestamp(), stopReason: String(reason).slice(0, 80) };
}

export function takeDesktopControl(value) {
  const current = normalizeDesktopBridge(value);
  if (!current.enabled) throw new Error('Computer access is not running.');
  clearDesktopUiaTargets();
  return { ...current, agentControlActive: false, takeoverAt: timestamp(), lastActionAt: timestamp() };
}

export function resumeDesktopControl(value) {
  const current = normalizeDesktopBridge(value);
  if (!current.enabled || !current.controlGranted || !current.ownerApproved) throw new Error('Computer control is not granted for this session.');
  clearDesktopUiaTargets();
  return { ...current, agentControlActive: true, lastActionAt: timestamp() };
}

export function clearDesktopUiaTargets() { desktopUiaTargets.clear(); }

export function desktopBridgeAuthorized(value, { linkId, capability, action = 'use' } = {}) {
  const bridge = normalizeDesktopBridge(value);
  if (!bridge.enabled || bridge.linkId !== cleanId(linkId)) throw new Error('The computer bridge is not active for this Hexonaut.');
  if (capability === 'desktop-view' && !bridge.viewGranted) throw new Error('This Hexonaut was not granted screen view.');
  if (capability === 'desktop-control') {
    if (!bridge.controlGranted) throw new Error('This Hexonaut was not granted computer control.');
    if (!bridge.agentControlActive) throw new Error(`Computer control is paused because the owner took over. ${action} was not sent.`);
  }
  if (capability === 'desktop-type' && (!bridge.controlGranted || !bridge.textGranted)) throw new Error('Text input is not granted for this computer session.');
  return bridge;
}

export function enforceDesktopRateLimit(linkId, kind = 'frame') {
  const id = cleanId(linkId); const interval = kind === 'frame' || kind.startsWith('uia-') ? 500 : 100;
  const now = Date.now(); const previous = desktopRate.get(`${id}:${kind}`) || 0;
  if (now - previous < interval) {
    const error = new Error('The computer bridge is rate-limited for safety. Wait a moment and try again.');
    error.code = 'DESKTOP_RATE_LIMIT'; error.status = 429; throw error;
  }
  desktopRate.set(`${id}:${kind}`, now);
}

function platformError() {
  const error = new Error('Native desktop access is not available on this computer platform yet.');
  error.code = 'DESKTOP_PLATFORM_UNAVAILABLE';
  error.status = 409;
  return error;
}

function runProcess(command, args, { spawnFn = defaultSpawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('The native desktop helper timed out.'), { code: 'DESKTOP_HELPER_TIMEOUT', status: 504 })); }, timeoutMs);
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { const detail = Buffer.concat(stderr).toString('utf8').trim(); reject(Object.assign(new Error(detail || `The native desktop helper exited with code ${code}.`), { code: 'DESKTOP_HELPER_FAILED', status: 502 })); return; }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function withTempJson(value, operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-desktop-'));
  const file = path.join(directory, 'request.json');
  try { await fs.writeFile(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); return await operation(file); }
  finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

export async function captureDesktopFrame({ platform = process.platform, spawnFn = defaultSpawn } = {}) {
  if (platform !== 'win32') throw platformError();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-frame-'));
  const output = path.join(directory, 'screen.png');
  try {
    await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'desktop-capture.ps1'), '-OutputPath', output], { spawnFn });
    const data = await fs.readFile(output);
    if (!data.length || data.length > MAX_FRAME_BYTES || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Object.assign(new Error('The desktop helper did not return a valid PNG frame.'), { status: 502 });
    return { mimeType: 'image/png', data, capturedAt: timestamp() };
  } catch (error) {
    const browserFrame = readBrowserDesktopFrame();
    if (browserFrame) return browserFrame;
    throw error;
  } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

function normalizeInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Computer input must be an object.');
  const kind = String(input.kind || '').trim();
  if (kind === 'mouse.move') {
    const x = Number(input.x); const y = Number(input.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) throw new Error('Mouse coordinates are invalid.');
    return { kind, x, y };
  }
  if (kind === 'mouse.click') {
    const button = ['left', 'right', 'middle'].includes(input.button) ? input.button : '';
    if (!button) throw new Error('Mouse clicks must name left, right, or middle.');
    return { kind, button };
  }
  if (kind === 'mouse.scroll') {
    const steps = Number(input.steps);
    if (!Number.isInteger(steps) || steps === 0 || Math.abs(steps) > 10) throw new Error('Scroll steps must be a nonzero integer from -10 to 10.');
    return { kind, steps };
  }
  if (kind === 'key.press') {
    const key = String(input.key || '').trim();
    const keyCode = /^[A-Za-z0-9]$/.test(key) ? key.toUpperCase().charCodeAt(0) : KEY_CODES[key];
    if (!keyCode) throw new Error('That keyboard key is not allowed.');
    return { kind, key: key.length === 1 ? key.toUpperCase() : key, keyCode };
  }
  if (kind === 'text.type') {
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text || text.length > MAX_TYPED_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error(`Text input must contain 1 to ${MAX_TYPED_CHARACTERS} printable characters.`);
    return { kind, text };
  }
  throw new Error('Only mouse.move, mouse.click, mouse.scroll, key.press, and granted text.type are available.');
}

export async function dispatchDesktopInput(input, { platform = process.platform, spawnFn = defaultSpawn } = {}) {
  if (platform !== 'win32') throw platformError();
  const safeInput = normalizeInput(input);
  return withTempJson(safeInput, async (file) => {
    const output = await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'desktop-input.ps1'), '-InputPath', file], { spawnFn, timeoutMs: 10000 });
    if (output.length > MAX_INPUT_BYTES) throw Object.assign(new Error('The native desktop helper returned too much data.'), { status: 502 });
    let native;
    try { native = JSON.parse(output.toString('utf8').trim()); }
    catch { throw Object.assign(new Error('The native desktop helper did not confirm the requested action.'), { code: 'DESKTOP_HELPER_UNVERIFIED', status: 502 }); }
    if (native?.ok !== true || native.kind !== safeInput.kind) throw Object.assign(new Error('The native desktop helper returned an invalid action receipt.'), { code: 'DESKTOP_HELPER_UNVERIFIED', status: 502 });
    return {
      ok: true,
      action: safeInput.kind,
      actedAt: timestamp(),
      eventsSent: Number(native.eventsSent || 0),
      cursorBefore: native.cursorBefore || null,
      cursorAfter: native.cursorAfter || null
    };
  });
}

function boundedUiaText(value, max = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max) : '';
}

function pruneExpiredUiaTargets(now = Date.now()) {
  for (const [key, record] of desktopUiaTargets) if (record.expiresAt <= now) desktopUiaTargets.delete(key);
  while (desktopUiaTargets.size > 256) desktopUiaTargets.delete(desktopUiaTargets.keys().next().value);
}

function runDesktopUiaHelper(request, { spawnFn = defaultSpawn } = {}) {
  return withTempJson(request, async (file) => {
    const output = await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'desktop-uia.ps1'), '-InputPath', file], { spawnFn, timeoutMs: 10000 });
    if (!output.length || output.length > 256 * 1024) throw Object.assign(new Error('The UI Automation helper returned an invalid response size.'), { status: 502 });
    let native;
    try { native = JSON.parse(output.toString('utf8').trim()); }
    catch { throw Object.assign(new Error('The UI Automation helper returned an unreadable response.'), { code: 'DESKTOP_UIA_UNVERIFIED', status: 502 }); }
    if (!native || typeof native !== 'object' || native.ok !== true && native.fallback !== 'screenshot-coordinate') {
      throw Object.assign(new Error('The UI Automation helper did not verify its response.'), { code: 'DESKTOP_UIA_UNVERIFIED', status: 502 });
    }
    return native;
  });
}

export async function inspectDesktopUia({ linkId, bridgeStartedAt, platform = process.platform, spawnFn = defaultSpawn } = {}) {
  if (platform !== 'win32') throw platformError();
  const id = cleanId(linkId);
  if (!id || typeof bridgeStartedAt !== 'string' || !bridgeStartedAt) throw new Error('UI Automation needs the active signed desktop session.');
  clearDesktopUiaTargets();
  pruneExpiredUiaTargets();
  let native;
  try { native = await runDesktopUiaHelper({ operation: 'inspect' }, { spawnFn }); }
  catch { return { ok: true, fallback: 'screenshot-coordinate', reason: 'Accessible controls could not be read. Capture a fresh screenshot before using coordinate control.' }; }
  if (native.fallback === 'screenshot-coordinate') return { ok: true, fallback: 'screenshot-coordinate', reason: boundedUiaText(native.reason, 120) || 'No usable accessible controls were found in the active window.' };
  if (native.operation !== 'inspect' || !Array.isArray(native.controls)) return { ok: true, fallback: 'screenshot-coordinate', reason: 'Accessible controls could not be verified. Capture a fresh screenshot before using coordinate control.' };
  const controls = [];
  for (const item of native.controls.slice(0, MAX_UIA_CONTROLS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!Array.isArray(item.runtimeId) || item.runtimeId.length < 1 || item.runtimeId.length > 16 || !item.runtimeId.every(Number.isSafeInteger)) continue;
    if (!Number.isSafeInteger(native.windowHandle) || native.windowHandle <= 0) continue;
    if (!item.bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(item.bounds[key]))) continue;
    const targetKey = randomUUID();
    const supports = { setValue: item.supports?.setValue === true, toggle: item.supports?.toggle === true };
    const fingerprint = {
      name: boundedUiaText(item.name),
      automationId: boundedUiaText(item.automationId, 100),
      controlType: boundedUiaText(item.controlType, 80),
      bounds: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(item.bounds[key])]))
    };
    desktopUiaTargets.set(targetKey, { linkId: id, bridgeStartedAt, windowHandle: native.windowHandle, runtimeId: item.runtimeId, supports, fingerprint, expiresAt: Date.now() + UIA_TARGET_TTL_MS });
    controls.push({
      targetKey,
      ...fingerprint,
      enabled: item.enabled === true,
      supports
    });
  }
  const result = { ok: true, window: { name: boundedUiaText(native.windowName) }, controls, truncated: native.truncated === true };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_UIA_RESPONSE_BYTES && controls.length) {
    const removed = controls.pop(); desktopUiaTargets.delete(removed.targetKey); result.truncated = true;
  }
  if (!controls.length) return { ok: true, fallback: 'screenshot-coordinate', reason: 'The active window did not expose bounded, usable controls.' };
  return result;
}

export async function actDesktopUia(input, { linkId, bridgeStartedAt, platform = process.platform, spawnFn = defaultSpawn } = {}) {
  if (platform !== 'win32') throw platformError();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('UI Automation action must be an object.');
  const id = cleanId(linkId); const targetKey = typeof input.targetKey === 'string' ? input.targetKey : '';
  if (!id || !targetKey) throw new Error('Choose a current inspected UI Automation target.');
  const record = desktopUiaTargets.get(targetKey);
  if (!record || record.expiresAt <= Date.now() || record.linkId !== id || record.bridgeStartedAt !== bridgeStartedAt) {
    desktopUiaTargets.delete(targetKey);
    return { ok: true, verified: false, fallback: 'screenshot-coordinate', reason: 'That control target expired or belongs to a different Link session; inspect the active window again.' };
  }
  let request;
  if (input.kind === 'toggle') {
    if (typeof input.expected !== 'boolean') throw new Error('A toggle action must declare its expected boolean state.');
    if (!record.supports.toggle) throw new Error('That inspected control does not support a toggle action.');
    request = { operation: 'toggle', windowHandle: record.windowHandle, runtimeId: record.runtimeId, fingerprint: record.fingerprint, expected: input.expected };
  } else if (input.kind === 'set-value') {
    const value = typeof input.value === 'string' ? input.value : '';
    if (!value || value.length > MAX_TYPED_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`UI Automation text must contain 1 to ${MAX_TYPED_CHARACTERS} printable characters.`);
    if (!record.supports.setValue) throw new Error('That inspected control does not support a text-value action.');
    request = { operation: 'set-value', windowHandle: record.windowHandle, runtimeId: record.runtimeId, fingerprint: record.fingerprint, value };
  } else throw new Error('UI Automation supports only verified toggle and set-value actions.');
  const uncertain = () => {
    desktopUiaTargets.delete(targetKey);
    return { ok: true, verified: false, fallback: 'screenshot-coordinate', mayHaveApplied: true, reason: 'The action may have applied but could not be verified. Inspect the active screen before retrying.' };
  };
  let native;
  try { native = await runDesktopUiaHelper(request, { spawnFn }); }
  catch { return uncertain(); }
  if (native.fallback === 'screenshot-coordinate') {
    if (native.mayHaveApplied === true) return uncertain();
    return { ok: true, verified: false, fallback: 'screenshot-coordinate', reason: boundedUiaText(native.reason, 120) || 'The active control could not be revalidated.' };
  }
  if (native.operation !== input.kind || native.verified !== true || typeof native.changed !== 'boolean') return uncertain();
  return { ok: true, action: input.kind, verified: true, changed: native.changed, actedAt: timestamp() };
}

export function normalizeDesktopInput(input) { return normalizeInput(input); }
