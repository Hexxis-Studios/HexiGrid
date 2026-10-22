import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createWindowsIncomingCallNotifier, HEXIGRID_WINDOWS_TOAST_APP_ID } from '../lib/windows-incoming-call-notification.mjs';
import { applyOwnerIncomingVoiceCallAction } from '../lib/desktop-bridge-routes.mjs';
import { startDesktopMedia, publicDesktopMedia, stopDesktopMedia } from '../lib/desktop-media.mjs';
import { initiateVoiceCall, publicVoiceCall, resetVoiceCallForTests, setVoiceCallNotificationChannel } from '../lib/voice-call.mjs';

function callFixture() {
  const connection = {
    id: 'link-notification-1', agentId: 'agent-notification-1', status: 'connected',
    capabilities: ['desktop-view', 'microphone-listen', 'speaker-output'],
    events: [], nextSequence: 1
  };
  const state = {
    settings: { desktopBridge: { enabled: true, linkId: connection.id, viewGranted: true, ownerApproved: true } },
    agentLinks: [connection]
  };
  return { state, connection };
}

test.beforeEach(() => {
  resetVoiceCallForTests();
  stopDesktopMedia('test-reset');
});

test('notification choice belongs to the exact ringing call and does not change on stale callbacks', () => {
  const { connection } = callFixture();
  const call = initiateVoiceCall({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
  assert.equal(call.notificationChannel, 'pending');
  setVoiceCallNotificationChannel('stale-call', 'browser');
  assert.equal(publicVoiceCall().notificationChannel, 'pending');
  setVoiceCallNotificationChannel(call.id, 'windows');
  assert.equal(publicVoiceCall().notificationChannel, 'windows');
});

test('Windows call toast offers owner actions without asking the browser to open or focus', async () => {
  let options;
  let callback;
  const applied = [];
  const notifier = {
    WindowsToaster: class {
      notify(value, done) { options = value; callback = done; }
    }
  };
  const native = createWindowsIncomingCallNotifier({
    platform: 'win32', notifier,
    onAction: async (action) => applied.push(action)
  });

  assert.equal(native.available, true);
  assert.equal(native.notify({ id: 'call-toast-1', status: 'ringing', direction: 'agent-to-owner', callerName: 'ExampleAgent\ncalling' }), true);
  assert.equal(options.title, 'HexiGrid');
  assert.equal(options.message, 'ExampleAgent calling wants to call you.');
  assert.deepEqual(options.actions, ['Allow', 'Deny']);
  assert.equal(options.appID, HEXIGRID_WINDOWS_TOAST_APP_ID);
  assert.equal(options.timeout, 45, 'the toast remains actionable for the call lifetime');
  assert.equal(existsSync(options.icon), true);
  assert.equal('open' in options, false);

  callback(null, { action: 'buttonClicked', button: 'Allow', activationType: 'Allow' });
  callback(null, { action: 'buttonClicked', button: 'Deny', activationType: 'Deny' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, [{ action: 'accept', callId: 'call-toast-1' }]);
});

test('asynchronous toast failure restores the browser prompt for the exact ringing call', () => {
  const { connection } = callFixture();
  const call = initiateVoiceCall({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
  let callback;
  let applied = 0;
  const errors = [];
  const notifier = { WindowsToaster: class { notify(_options, done) { callback = done; } } };
  const native = createWindowsIncomingCallNotifier({
    platform: 'win32', notifier,
    onAction: () => { applied += 1; },
    onError: (error, { callId } = {}) => {
      errors.push({ code: error.code, callId });
      setVoiceCallNotificationChannel(callId, 'browser');
    }
  });

  assert.equal(native.notify(call), true, 'queueing alone cannot prove Windows delivered the toast');
  callback(Object.assign(new Error('Windows notifications are disabled'), { code: -1 }), {
    action: 'buttonClicked', button: 'Allow', activationType: 'Allow'
  });
  callback(null, { action: 'buttonClicked', button: 'Allow', activationType: 'Allow' });
  assert.deepEqual(errors, [{ code: -1, callId: call.id }]);
  assert.equal(publicVoiceCall().status, 'ringing');
  assert.equal(publicVoiceCall().notificationChannel, 'browser');
  assert.equal(applied, 0, 'a failed toast cannot also accept the call');
});

test('Windows toast is unavailable off Windows and ignores non-ringing calls', () => {
  let constructions = 0;
  const notifier = { WindowsToaster: class { constructor() { constructions += 1; } } };
  const native = createWindowsIncomingCallNotifier({ platform: 'linux', notifier });
  assert.equal(native.available, false);
  assert.equal(native.notify({ id: 'call', status: 'ringing', direction: 'agent-to-owner' }), false);
  assert.equal(constructions, 0);
});

test('toast acceptance revalidates the exact live bridge and grants, records its source, and does not fake a browser stream', async () => {
  const { state, connection } = callFixture();
  startDesktopMedia({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
  const offered = initiateVoiceCall({ linkId: connection.id, callerName: 'ExampleAgent', microphoneGranted: true, speakerGranted: true });
  const receipts = [];
  let transcriptCallId = '';
  let saves = 0;
  const result = await applyOwnerIncomingVoiceCallAction({
    state, callId: offered.id, action: 'accept', acceptedVia: 'windows-toast',
    connectorPolicy: () => null,
    addReceipt: receipt => (receipts.push(receipt), receipt),
    onVoiceCallStarted: voiceCall => { transcriptCallId = voiceCall.id; },
    saveState: async () => { saves += 1; }
  });
  assert.equal(result.voiceCall.status, 'active');
  assert.equal(result.voiceCall.acceptedVia, 'windows-toast');
  assert.equal(result.media.microphoneGranted, true);
  assert.equal(result.media.microphoneActive, false, 'server grant is not the same as an actual browser device stream');
  assert.equal(publicVoiceCall().status, 'active');
  assert.equal(connection.events.at(-1).type, 'voice.call.accepted');
  assert.equal(connection.events.at(-1).metadata.mediaEpoch, result.voiceCall.mediaEpoch);
  assert.equal(transcriptCallId, offered.id, 'incoming acceptance starts the call transcript buffer');
  assert.match(receipts[0].detail, /Windows notification/);
  assert.equal(saves, 1);
});

test('toast decline is link-scoped, closes the ringing call, and stale actions cannot affect a later call', async () => {
  const { state, connection } = callFixture();
  startDesktopMedia({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
  const offered = initiateVoiceCall({ linkId: connection.id, callerName: 'ExampleAgent', microphoneGranted: true, speakerGranted: true });
  const common = { state, connectorPolicy: () => null, addReceipt: () => ({}), saveState: async () => {} };
  const declined = await applyOwnerIncomingVoiceCallAction({ ...common, callId: offered.id, action: 'decline' });
  assert.equal(declined.voiceCall.status, 'ended');
  assert.equal(declined.voiceCall.stopReason, 'owner-declined');
  assert.equal(connection.events.at(-1).type, 'voice.call.ended');
  await assert.rejects(() => applyOwnerIncomingVoiceCallAction({ ...common, callId: offered.id, action: 'accept' }), /No live voice call|stale/);
});

test('expired incoming call is marked missed and a late toast Accept cannot revive it', async () => {
  const { state, connection } = callFixture();
  startDesktopMedia({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
  const offered = initiateVoiceCall({ linkId: connection.id, callerName: 'ExampleAgent', microphoneGranted: true, speakerGranted: true });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let receipts = 0;
  let saves = 0;
  try {
    now = Date.parse(offered.expiresAt) + 1;
    await assert.rejects(() => applyOwnerIncomingVoiceCallAction({
      state, callId: offered.id, action: 'accept', acceptedVia: 'windows-toast', connectorPolicy: () => null,
      addReceipt: () => { receipts += 1; return {}; }, saveState: async () => { saves += 1; }
    }), /No live voice call/);
    const expired = publicVoiceCall();
    assert.equal(expired.status, 'ended');
    assert.equal(expired.stopReason, 'missed');
    assert.equal(expired.id, offered.id);
    assert.equal(receipts, 0);
    assert.equal(saves, 0);
    assert.equal(connection.events.length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('toast accept refuses if live audio grants or conversation policy changed after ringing', async () => {
  const { state, connection } = callFixture();
  startDesktopMedia({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
  const offered = initiateVoiceCall({ linkId: connection.id, callerName: 'ExampleAgent', microphoneGranted: true, speakerGranted: true });
  connection.capabilities = connection.capabilities.filter(capability => capability !== 'microphone-listen');
  await assert.rejects(() => applyOwnerIncomingVoiceCallAction({
    state, callId: offered.id, action: 'accept', acceptedVia: 'windows-toast', connectorPolicy: () => null,
    addReceipt: () => ({}), saveState: async () => {}
  }), /Both audio permissions must still be granted/);
  assert.equal(publicVoiceCall().status, 'ringing');
  connection.capabilities.push('microphone-listen');
  await assert.rejects(() => applyOwnerIncomingVoiceCallAction({
    state, callId: offered.id, action: 'accept', acceptedVia: 'windows-toast', connectorPolicy: () => ({ denied: true, error: 'Conversation policy changed.' }),
    addReceipt: () => ({}), saveState: async () => {}
  }), /Conversation policy changed/);
  assert.equal(publicDesktopMedia().microphoneGranted, true);
  assert.equal(publicVoiceCall().status, 'ringing');
});
