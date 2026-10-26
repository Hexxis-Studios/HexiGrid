import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  captureDesktopFrame,
  coordinateDesktopRequest,
  actDesktopUia,
  clearDesktopUiaTargets,
  defaultDesktopBridge,
  desktopBridgeAuthorized,
  dispatchDesktopInput,
  enforceDesktopRateLimit,
  inspectDesktopUia,
  legacyDesktopMediaGrants,
  normalizeDesktopBridge,
  normalizeDesktopInput,
  publicDesktopBridge,
  resumeDesktopControl,
  startDesktopBridge,
  stopDesktopBridge,
  takeDesktopControl
} from '../lib/desktop-bridge.mjs';
import { desktopBridgeFramePayload } from '../lib/desktop-bridge-routes.mjs';
import { publishBrowserDesktopFrame, resetBrowserDesktopFrameForTests } from '../lib/desktop-screen.mjs';
import { callMediaBridge } from '../lib/call-media-authority.mjs';

test.beforeEach(() => resetBrowserDesktopFrameForTests());
test.beforeEach(() => clearDesktopUiaTargets());

test('desktop bridge starts with no computer permission', () => {
  const initial = defaultDesktopBridge();
  assert.equal(initial.enabled, false);
  assert.equal(initial.controlGranted, false);
  assert.equal(publicDesktopBridge(initial, { platform: 'linux' }).supported, false);
});

test('camera-only access survives normalization without granting screen view or control', () => {
  const bridge = startDesktopBridge(null, { linkId: 'camera-only', viewGranted: false, cameraGranted: true });
  const restored = normalizeDesktopBridge(JSON.parse(JSON.stringify(bridge)));
  assert.equal(restored.enabled, true);
  assert.equal(restored.viewGranted, false);
  assert.equal(restored.controlGranted, false);
  assert.equal(callMediaBridge({ settings: { desktopBridge: restored } }, 'camera-only').mediaGrants.camera, true);
  assert.throws(() => desktopBridgeAuthorized(restored, { linkId: 'camera-only', capability: 'desktop-view' }), /not granted screen/);
  assert.throws(() => desktopBridgeAuthorized(restored, { linkId: 'camera-only', capability: 'desktop-control' }), /not granted computer/);
  assert.throws(() => startDesktopBridge(null, { linkId: 'camera-only', viewGranted: false, cameraGranted: true, controlGranted: true }), /without screen view/);
  assert.throws(() => startDesktopBridge(null, { linkId: 'camera-only', viewGranted: false }), /Choose screen view or a media permission/);
});

test('saved media grants survive normalization but stop and owner-pause remain explicit', () => {
  const bridge = startDesktopBridge(defaultDesktopBridge(), {
    linkId: 'link-media-save', viewGranted: true,
    cameraGranted: true, microphoneGranted: true, speakerGranted: true
  });
  const restored = normalizeDesktopBridge(JSON.parse(JSON.stringify({
    ...bridge,
    mediaPausedByOwner: { camera: false, microphone: true, speaker: false }
  })));
  assert.deepEqual(restored.mediaGrants, { camera: true, microphone: true, speaker: true });
  assert.deepEqual(restored.mediaPausedByOwner, { camera: false, microphone: true, speaker: false });
  assert.deepEqual(stopDesktopBridge(restored).mediaGrants, { camera: false, microphone: false, speaker: false });
});

test('legacy media grants migrate only from the same connected owner-approved Link policy', () => {
  const bridge = { enabled: true, ownerApproved: true, viewGranted: true, linkId: 'exampleagent-link' };
  const link = {
    id: 'exampleagent-link', status: 'connected', trustLevel: 'owner',
    capabilities: ['desktop-view', 'camera-view', 'microphone-listen', 'speaker-output'],
    ownerGrantedCapabilities: ['desktop-view', 'camera-view', 'microphone-listen', 'speaker-output']
  };
  assert.deepEqual(legacyDesktopMediaGrants(bridge, link), { camera: true, microphone: true, speaker: true });
  assert.deepEqual(legacyDesktopMediaGrants(bridge, { ...link, capabilities: ['desktop-view', 'microphone-listen'] }), { camera: false, microphone: true, speaker: false });
  assert.equal(legacyDesktopMediaGrants(bridge, { ...link, id: 'another-link' }), null);
  assert.equal(legacyDesktopMediaGrants({ ...bridge, ownerApproved: false }, link), null);
  assert.equal(legacyDesktopMediaGrants({ ...bridge, mediaGrants: {} }, link), null);
});

test('desktop bridge lifecycle makes owner takeover and stop authoritative', () => {
  let bridge = startDesktopBridge(defaultDesktopBridge(), { linkId: 'link-1', viewGranted: true, controlGranted: true, textGranted: true });
  assert.equal(bridge.agentControlActive, true);
  assert.equal(bridge.textGranted, true);
  assert.equal(desktopBridgeAuthorized(bridge, { linkId: 'link-1', capability: 'desktop-type' }).textGranted, true);
  assert.equal(desktopBridgeAuthorized(bridge, { linkId: 'link-1', capability: 'desktop-view' }).enabled, true);
  bridge = takeDesktopControl(bridge);
  assert.equal(bridge.agentControlActive, false);
  assert.throws(() => desktopBridgeAuthorized(bridge, { linkId: 'link-1', capability: 'desktop-control', action: 'input' }), /owner took over/);
  bridge = resumeDesktopControl(bridge);
  assert.equal(bridge.agentControlActive, true);
  bridge = stopDesktopBridge(bridge);
  assert.equal(bridge.enabled, false);
  assert.throws(() => desktopBridgeAuthorized(bridge, { linkId: 'link-1', capability: 'desktop-view' }), /not active/);
});

test('desktop bridge requires the exact granted link and validates input kinds', () => {
  const bridge = startDesktopBridge(defaultDesktopBridge(), { linkId: 'link-1', viewGranted: true, controlGranted: false });
  assert.throws(() => desktopBridgeAuthorized(bridge, { linkId: 'link-2', capability: 'desktop-view' }), /not active/);
  assert.throws(() => desktopBridgeAuthorized(bridge, { linkId: 'link-1', capability: 'desktop-control' }), /not granted/);
  assert.deepEqual(normalizeDesktopInput({ kind: 'mouse.move', x: 2, y: 4 }), { kind: 'mouse.move', x: 2, y: 4 });
  assert.deepEqual(normalizeDesktopInput({ kind: 'key.press', key: 'Enter' }), { kind: 'key.press', key: 'Enter', keyCode: 13 });
  assert.deepEqual(normalizeDesktopInput({ kind: 'key.press', key: 'Win' }), { kind: 'key.press', key: 'Win', keyCode: 91 });
  assert.deepEqual(normalizeDesktopInput({ kind: 'mouse.scroll', steps: -3 }), { kind: 'mouse.scroll', steps: -3 });
  assert.deepEqual(normalizeDesktopInput({ kind: 'text.type', text: 'Hello 🌿' }), { kind: 'text.type', text: 'Hello 🌿' });
  assert.throws(() => normalizeDesktopInput({ kind: 'text.type', text: `x${'a'.repeat(1000)}` }), /1 to 1000 printable/);
  assert.throws(() => normalizeDesktopInput({ kind: 'text.type', text: 'safe\u0007unsafe' }), /printable/);
  assert.throws(() => normalizeDesktopInput({ kind: 'mouse.scroll', steps: 11 }), /-10 to 10/);
  assert.throws(() => normalizeDesktopInput({ kind: 'shell', command: 'whoami' }), /Only mouse/);
  assert.throws(() => normalizeDesktopInput({ kind: 'mouse.click', button: 'double' }), /left, right, or middle/);
});

test('desktop native helpers expose honest platform boundaries', async () => {
  await assert.rejects(() => captureDesktopFrame({ platform: 'linux' }), (error) => error.code === 'DESKTOP_PLATFORM_UNAVAILABLE');
  await assert.rejects(() => dispatchDesktopInput({ kind: 'mouse.move', x: 0, y: 0 }, { platform: 'linux' }), (error) => error.code === 'DESKTOP_PLATFORM_UNAVAILABLE');
  const malformed = normalizeDesktopBridge({ enabled: true, linkId: 'link-1', viewGranted: true, controlGranted: true, agentControlActive: true });
  assert.equal(malformed.enabled, true);
  assert.equal(malformed.linkId, 'link-1');
});

test('desktop input requires a verified native receipt and returns cursor telemetry', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, kind: 'mouse.move', eventsSent: 0, cursorBefore: { x: 20, y: 30 }, cursorAfter: { x: 40, y: 50 } })));
      child.emit('close', 0);
    });
    return child;
  };
  const result = await dispatchDesktopInput({ kind: 'mouse.move', x: 40, y: 50 }, { platform: 'win32', spawnFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cursorAfter, { x: 40, y: 50 });
});

test('desktop text and scroll dispatch require a complete native event receipt', async () => {
  const receipts = [];
  const spawnFn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const jsonPath = args.at(-1);
    import('node:fs/promises').then(async ({ readFile }) => {
      const input = JSON.parse(await readFile(jsonPath, 'utf8'));
      const eventsSent = input.kind === 'text.type' ? input.text.length * 2 : 1;
      receipts.push(input.kind);
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, kind: input.kind, eventsSent, cursorBefore: { x: 0, y: 0 }, cursorAfter: { x: 0, y: 0 } })));
      child.emit('close', 0);
    }).catch((error) => child.emit('error', error));
    return child;
  };
  assert.equal((await dispatchDesktopInput({ kind: 'text.type', text: 'Hi' }, { platform: 'win32', spawnFn })).eventsSent, 4);
  assert.equal((await dispatchDesktopInput({ kind: 'mouse.scroll', steps: 2 }, { platform: 'win32', spawnFn })).eventsSent, 1);
  assert.deepEqual(receipts, ['text.type', 'mouse.scroll']);
});

function uiaSpawn(response, captured = [], { raw, exitCode = 0, stderr = '' } = {}) {
  return (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.equal(args.at(-2), '-InputPath');
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    import('node:fs/promises').then(async ({ readFile }) => {
      captured.push(JSON.parse(await readFile(args.at(-1), 'utf8')));
      child.stdout.emit('data', Buffer.from(raw ?? JSON.stringify(response)));
      child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    }).catch((error) => child.emit('error', error));
    return child;
  };
}

test('UI Automation exposes bounded opaque active-window targets and verifies semantic actions', async () => {
  const requestLog = [];
  const targets = await inspectDesktopUia({ linkId: 'link-uia-owner', bridgeStartedAt: 'session-1', platform: 'win32', spawnFn: uiaSpawn({
    ok: true, operation: 'inspect', windowHandle: 44, windowName: 'Synthetic window', processId: 123,
    controls: [{ runtimeId: [1, 2, 3], name: 'Remember me', automationId: 'remember', controlType: 'CheckBox', bounds: { x: 1, y: 2, width: 20, height: 20 }, enabled: true, supports: { toggle: true } }], truncated: false
  }, requestLog) });
  assert.equal(targets.window.name, 'Synthetic window');
  assert.equal(targets.controls.length, 1);
  assert.equal(targets.controls[0].name, 'Remember me');
  assert.equal(Object.hasOwn(targets.controls[0], 'runtimeId'), false);
  const result = await actDesktopUia({ kind: 'toggle', targetKey: targets.controls[0].targetKey, expected: true }, {
    linkId: 'link-uia-owner', bridgeStartedAt: 'session-1', platform: 'win32',
    spawnFn: uiaSpawn({ ok: true, operation: 'toggle', verified: true, changed: true }, requestLog)
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'toggle');
  assert.equal(result.verified, true);
  assert.equal(result.changed, true);
  assert.deepEqual(requestLog, [
    { operation: 'inspect' },
    { operation: 'toggle', windowHandle: 44, runtimeId: [1, 2, 3], fingerprint: { name: 'Remember me', automationId: 'remember', controlType: 'CheckBox', bounds: { x: 1, y: 2, width: 20, height: 20 } }, expected: true }
  ]);
  assert.equal(Number.isFinite(Date.parse(result.actedAt)), true);
});

test('UI Automation text values require a previously advertised target and never echo the value', async () => {
  const targets = await inspectDesktopUia({ linkId: 'link-uia-text', bridgeStartedAt: 'session-text', platform: 'win32', spawnFn: uiaSpawn({
    ok: true, operation: 'inspect', windowHandle: 47, controls: [{ runtimeId: [8], name: 'Search', controlType: 'Edit', bounds: { x: 2, y: 4, width: 50, height: 20 }, enabled: true, supports: { setValue: true } }]
  }) });
  const captured = [];
  const result = await actDesktopUia({ kind: 'set-value', targetKey: targets.controls[0].targetKey, value: 'synthetic query' }, {
    linkId: 'link-uia-text', bridgeStartedAt: 'session-text', platform: 'win32',
    spawnFn: uiaSpawn({ ok: true, operation: 'set-value', verified: true, changed: true }, captured)
  });
  assert.equal(result.verified, true);
  assert.equal(Object.hasOwn(result, 'value'), false);
  assert.equal(captured[0].value, 'synthetic query');
});

test('UI Automation inspection is capped by both control count and serialized bytes', async () => {
  const controls = Array.from({ length: 128 }, (_, index) => ({ runtimeId: [index + 1], name: 'N'.repeat(160), automationId: 'A'.repeat(100), controlType: 'ControlType.Custom', enabled: true, bounds: { x: 1, y: 2, width: 30, height: 40 }, supports: { toggle: false, setValue: false } }));
  const result = await inspectDesktopUia({ linkId: 'link-uia-bounds', bridgeStartedAt: 'session-bounds', platform: 'win32', spawnFn: uiaSpawn({ ok: true, operation: 'inspect', windowHandle: 48, windowName: 'W'.repeat(500), controls, truncated: true }) });
  assert.ok(result.controls.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16 * 1024);
  assert.equal(result.truncated, true);
});

test('UI Automation rejects unsupported actions and invalid text without dispatch', async () => {
  const targets = await inspectDesktopUia({ linkId: 'link-uia-validation', bridgeStartedAt: 'session-2', platform: 'win32', spawnFn: uiaSpawn({
    ok: true, operation: 'inspect', windowHandle: 45, controls: [{ runtimeId: [9], name: '', automationId: '', controlType: 'Edit', bounds: { x: 2, y: 4, width: 50, height: 20 }, enabled: true, supports: { setValue: true } }]
  }) });
  await assert.rejects(() => actDesktopUia({ kind: 'invoke', targetKey: targets.controls[0].targetKey }, { linkId: 'link-uia-validation', bridgeStartedAt: 'session-2', platform: 'win32', spawnFn: () => { throw new Error('must not dispatch'); } }), /only verified toggle and set-value/);
  await assert.rejects(() => actDesktopUia({ kind: 'set-value', targetKey: targets.controls[0].targetKey, value: 'bad\u0007text' }, { linkId: 'link-uia-validation', bridgeStartedAt: 'session-2', platform: 'win32', spawnFn: () => { throw new Error('must not dispatch'); } }), /printable characters/);
  await assert.rejects(() => actDesktopUia({ kind: 'toggle', targetKey: targets.controls[0].targetKey, expected: true }, { linkId: 'link-uia-validation', bridgeStartedAt: 'session-2', platform: 'win32', spawnFn: () => { throw new Error('unadvertised action must not dispatch'); } }), /does not support a toggle/);
});

test('UI Automation targets expire across Link, session, and takeover lifecycle', async () => {
  const targets = await inspectDesktopUia({ linkId: 'link-uia-bound', bridgeStartedAt: 'session-a', platform: 'win32', spawnFn: uiaSpawn({
    ok: true, operation: 'inspect', windowHandle: 46, controls: [{ runtimeId: [7], name: 'Switch', controlType: 'Button', bounds: { x: 2, y: 4, width: 50, height: 20 }, enabled: true, supports: { toggle: true } }]
  }) });
  const stale = await actDesktopUia({ kind: 'toggle', targetKey: targets.controls[0].targetKey, expected: true }, { linkId: 'link-uia-other', bridgeStartedAt: 'session-a', platform: 'win32', spawnFn: () => { throw new Error('stale target must not dispatch'); } });
  assert.equal(stale.verified, false);
  const staleSession = await actDesktopUia({ kind: 'toggle', targetKey: targets.controls[0].targetKey, expected: true }, { linkId: 'link-uia-bound', bridgeStartedAt: 'session-b', platform: 'win32', spawnFn: () => { throw new Error('stale session must not dispatch'); } });
  assert.equal(staleSession.verified, false);
  const bridge = startDesktopBridge(defaultDesktopBridge(), { linkId: 'link-uia-bound', viewGranted: true, controlGranted: true });
  const cleared = await actDesktopUia({ kind: 'toggle', targetKey: targets.controls[0].targetKey, expected: true }, { linkId: 'link-uia-bound', bridgeStartedAt: bridge.startedAt, platform: 'win32', spawnFn: () => { throw new Error('lifecycle change must clear targets'); } });
  assert.equal(cleared.verified, false);
  const afterResumeInspection = await inspectDesktopUia({ linkId: 'link-uia-bound', bridgeStartedAt: bridge.startedAt, platform: 'win32', spawnFn: uiaSpawn({
    ok: true, operation: 'inspect', windowHandle: 46, controls: [{ runtimeId: [7], name: 'Switch', controlType: 'Button', bounds: { x: 2, y: 4, width: 50, height: 20 }, enabled: true, supports: { toggle: true } }]
  }) });
  const taken = takeDesktopControl(bridge);
  const afterTakeover = await actDesktopUia({ kind: 'toggle', targetKey: afterResumeInspection.controls[0].targetKey, expected: true }, { linkId: 'link-uia-bound', bridgeStartedAt: bridge.startedAt, platform: 'win32', spawnFn: () => { throw new Error('owner takeover must clear targets'); } });
  assert.equal(afterTakeover.verified, false);
  const resumed = resumeDesktopControl(taken);
  const afterResume = await inspectDesktopUia({ linkId: 'link-uia-bound', bridgeStartedAt: resumed.startedAt, platform: 'win32', spawnFn: uiaSpawn({
    ok: true, operation: 'inspect', windowHandle: 46, controls: [{ runtimeId: [7], name: 'Switch', controlType: 'Button', bounds: { x: 2, y: 4, width: 50, height: 20 }, enabled: true, supports: { toggle: true } }]
  }) });
  stopDesktopBridge(resumed);
  const afterStop = await actDesktopUia({ kind: 'toggle', targetKey: afterResume.controls[0].targetKey, expected: true }, { linkId: 'link-uia-bound', bridgeStartedAt: resumed.startedAt, platform: 'win32', spawnFn: () => { throw new Error('stop must clear targets'); } });
  assert.equal(afterStop.verified, false);
});

test('UI Automation inspection returns the existing screenshot fallback when no accessible tree is usable', async () => {
  const result = await inspectDesktopUia({ linkId: 'link-uia-fallback', bridgeStartedAt: 'session-fallback', platform: 'win32', spawnFn: uiaSpawn({ ok: false, fallback: 'screenshot-coordinate', reason: 'Synthetic inaccessible window.' }) });
  assert.deepEqual(result, { ok: true, fallback: 'screenshot-coordinate', reason: 'Synthetic inaccessible window.' });
  const target = await inspectDesktopUia({ linkId: 'link-uia-fallback', bridgeStartedAt: 'session-fallback', platform: 'win32', spawnFn: uiaSpawn({ ok: true, operation: 'inspect', windowHandle: 49, controls: [{ runtimeId: [11], name: 'Check', controlType: 'CheckBox', bounds: { x: 1, y: 2, width: 20, height: 20 }, enabled: true, supports: { toggle: true } }] }) });
  const uncertain = await actDesktopUia({ kind: 'toggle', targetKey: target.controls[0].targetKey, expected: true }, { linkId: 'link-uia-fallback', bridgeStartedAt: 'session-fallback', platform: 'win32', spawnFn: uiaSpawn({ ok: false, fallback: 'screenshot-coordinate', reason: 'Synthetic postcondition unavailable.', mayHaveApplied: true }) });
  assert.equal(uncertain.verified, false);
  assert.equal(uncertain.mayHaveApplied, true);
});

test('UI Automation helper failures return bounded guidance without native diagnostics', async () => {
  for (const spawnFn of [
    uiaSpawn(null, [], { raw: 'private-native-diagnostic' }),
    uiaSpawn(null, [], { raw: '', exitCode: 1, stderr: 'private-native-diagnostic' }),
    uiaSpawn({ ok: true, operation: 'toggle', controls: [] }),
    uiaSpawn({ ok: true, operation: 'inspect', windowHandle: 44, controls: [null, false, []] })
  ]) {
    const result = await inspectDesktopUia({ linkId: 'failure-test', bridgeStartedAt: 'session', platform: 'win32', spawnFn });
    assert.equal(result.fallback, 'screenshot-coordinate');
    assert.equal(JSON.stringify(result).includes('private-native-diagnostic'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 512);
  }
});

test('unverified dispatched UIA actions invalidate their targets and prohibit blind retries', async () => {
  for (const failedSpawn of [
    uiaSpawn(null, [], { raw: 'private-native-diagnostic' }),
    uiaSpawn(null, [], { raw: '', exitCode: 1, stderr: 'private-native-diagnostic' }),
    uiaSpawn({ ok: true, operation: 'set-value', verified: true, changed: true }),
    uiaSpawn({ ok: true, operation: 'toggle', verified: false, changed: false }),
    uiaSpawn({ ok: false, fallback: 'screenshot-coordinate', mayHaveApplied: true })
  ]) {
    const options = { linkId: 'failure-test', bridgeStartedAt: 'session', platform: 'win32' };
    const tree = await inspectDesktopUia({ ...options, spawnFn: uiaSpawn({ ok: true, operation: 'inspect', windowHandle: 44, controls: [{ runtimeId: [1], bounds: { x: 1, y: 2, width: 20, height: 20 }, supports: { toggle: true } }] }) });
    const action = { kind: 'toggle', targetKey: tree.controls[0].targetKey, expected: true };
    const result = await actDesktopUia(action, { ...options, spawnFn: failedSpawn });
    assert.equal(result.verified, false);
    assert.equal(result.mayHaveApplied, true);
    assert.equal(JSON.stringify(result).includes('private-native-diagnostic'), false);
    const retry = await actDesktopUia(action, { ...options, spawnFn: () => { throw new Error('retry must not dispatch'); } });
    assert.equal(retry.verified, false);
    assert.equal(retry.mayHaveApplied, undefined);
  }
});

test('desktop bridge rate limits frames and input bursts', () => {
  enforceDesktopRateLimit('link-rate-test', 'frame');
  assert.throws(() => enforceDesktopRateLimit('link-rate-test', 'frame'), /rate-limited/);
  enforceDesktopRateLimit('link-rate-test', 'input');
  assert.throws(() => enforceDesktopRateLimit('link-rate-test', 'input'), /rate-limited/);
  enforceDesktopRateLimit('link-rate-test', 'uia-inspect');
  assert.throws(() => enforceDesktopRateLimit('link-rate-test', 'uia-inspect'), /rate-limited/);
});

test('desktop view falls back to the owner browser when Windows native capture is unavailable', async () => {
  publishBrowserDesktopFrame({ mimeType: 'image/jpeg', data: Buffer.from('owner-screen').toString('base64'), capturedAt: new Date().toISOString() });
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('close', 1));
    return child;
  };
  const frame = await captureDesktopFrame({ platform: 'win32', spawnFn });
  assert.equal(frame.source, 'owner-browser');
  assert.equal(frame.data.toString(), 'owner-screen');
  assert.equal(desktopBridgeFramePayload(frame).source, 'owner-browser');
});


test('parallel sharing preserves approved control for both Links and honors global takeover', async () => {
  const {desktopBridgeSession, publicDesktopBridge} = await import('../lib/desktop-bridge.mjs');
  let bridge = startDesktopBridge({}, {linkId: 'first', viewGranted: true, controlGranted: true, textGranted: true});
  bridge = startDesktopBridge(bridge, {linkId: 'second', viewGranted: true, controlGranted: true, textGranted: true, cameraGranted: true});
  assert.equal(desktopBridgeAuthorized(bridge, {linkId: 'first', capability: 'desktop-control'}).enabled, true);
  assert.equal(desktopBridgeAuthorized(bridge, {linkId: 'second', capability: 'desktop-control'}).enabled, true);
  assert.equal(desktopBridgeSession(bridge, 'second').mediaGrants.camera, true);
  assert.equal(publicDesktopBridge(bridge, {includeSessions: false}).sessions, undefined, 'signed snapshots can exclude other Links');
  bridge = takeDesktopControl(bridge);
  assert.throws(() => desktopBridgeAuthorized(bridge, {linkId: 'first', capability: 'desktop-control'}), /paused/);
  assert.throws(() => desktopBridgeAuthorized(bridge, {linkId: 'second', capability: 'desktop-control'}), /paused/);
  const resumed = resumeDesktopControl(bridge);
  for (const linkId of ['first', 'second']) assert.equal(desktopBridgeAuthorized(resumed, {linkId, capability: 'desktop-control'}).agentControlActive, true);
  bridge = stopDesktopBridge(bridge, 'agent-stop', 'second');
  assert.equal(bridge.linkId, 'first');
  assert.equal(desktopBridgeSession(bridge, 'second').enabled, false);
  bridge = stopDesktopBridge(bridge, 'owner-stop');
  assert.deepEqual(bridge.sessions, {});
});

test('camera-only startup cannot undo global owner takeover, including legacy saved sessions', () => {
  let bridge = takeDesktopControl(startDesktopBridge({}, { linkId: 'paused-owner', viewGranted: true, controlGranted: true }));
  delete bridge.ownerControlPaused;
  bridge = normalizeDesktopBridge(bridge);
  assert.equal(bridge.ownerControlPaused, true);
  bridge = startDesktopBridge(bridge, { linkId: 'camera-new', viewGranted: false, cameraGranted: true });
  assert.equal(bridge.ownerControlPaused, true);
  assert.throws(() => desktopBridgeAuthorized(bridge, { linkId: 'paused-owner', capability: 'desktop-control' }), /owner took over/);
});

test('desktop requests coordinate across agents, reject stale views and recover after failures', async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = linkId => ({ linkId, authorize: () => ({ startedAt: 'coordination-session' }) });
  const observe = linkId => coordinateDesktopRequest({ ...options(linkId), observe: true }, async () => { order.push(`${linkId}:view`); });
  await observe('coord-a');
  const first = coordinateDesktopRequest(options('coord-a'), async () => { order.push('a:start'); await gate; order.push('a:end'); });
  const secondView = observe('coord-b');
  const second = coordinateDesktopRequest(options('coord-b'), async () => { order.push('b:action'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['coord-a:view', 'a:start']);
  release(); await Promise.all([first, secondView, second]);
  assert.deepEqual(order, ['coord-a:view', 'a:start', 'a:end', 'coord-b:view', 'b:action']);
  await assert.rejects(coordinateDesktopRequest(options('coord-a'), () => assert.fail('stale action must not dispatch')), { code: 'DESKTOP_VIEW_STALE' });
  await observe('coord-a');
  await assert.rejects(coordinateDesktopRequest(options('coord-a'), async () => { throw Error('synthetic helper failure'); }), /synthetic helper failure/);
  await observe('coord-b');
  await coordinateDesktopRequest(options('coord-b'), async () => { order.push('b:recovered'); });
  assert.equal(order.at(-1), 'b:recovered');
});

test('queued desktop actions recheck owner takeover or revoked authority before dispatch', async () => {
  let allowed = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { linkId: 'queued-revoke', authorize: () => { if (!allowed) throw Object.assign(Error('owner took over'), { status: 403 }); return { startedAt: 'revoke-session' }; } };
  await coordinateDesktopRequest({ ...options, observe: true }, async () => {});
  const pending = coordinateDesktopRequest(options, async () => { await gate; });
  const denied = coordinateDesktopRequest(options, () => assert.fail('queued revoked action must not dispatch'));
  const pendingCheck = assert.rejects(pending, error => error.status === 403 && error.mayHaveApplied === true);
  const deniedCheck = assert.rejects(denied, error => error.status === 403 && !error.mayHaveApplied);
  await new Promise(resolve => setImmediate(resolve));
  allowed = false; release();
  await Promise.all([pendingCheck, deniedCheck]);
});

test('native input revalidates authority after writing its private request but before dispatch', async () => {
  await assert.rejects(dispatchDesktopInput({ kind: 'text.type', text: 'synthetic' }, { platform: 'win32', authorize() { throw Error('revoked before spawn'); }, spawnFn() { assert.fail('no native helper after revocation'); } }), /revoked before spawn/);
});

test('owner takeover and resume require a new observation rather than replaying old input', async () => {
  let bridge = startDesktopBridge({}, { linkId: 'takeover-observation', viewGranted: true, controlGranted: true });
  const options = { linkId: 'takeover-observation', authorize: () => desktopBridgeAuthorized(bridge, { linkId: 'takeover-observation', capability: 'desktop-control' }) };
  await coordinateDesktopRequest({ ...options, observe: true }, async () => {});
  await coordinateDesktopRequest(options, async () => {});
  bridge = resumeDesktopControl(takeDesktopControl(bridge));
  await assert.rejects(coordinateDesktopRequest(options, () => assert.fail('old view cannot authorize a resumed action')), { code: 'DESKTOP_VIEW_STALE' });
  await coordinateDesktopRequest({ ...options, observe: true }, async () => {});
  await coordinateDesktopRequest(options, async () => {});
});
