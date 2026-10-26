import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/live-call.js', import.meta.url), 'utf8');

test('Calls starts paired agents with idle heartbeats and keeps actual access restrictions', async () => {
  const calls = [];
  const callRequests = [];
  const notifications = [];
  let ignoreContactSave = false;
  const list = { innerHTML: '' };
  const status = { textContent: '', classList: { toggle() {} } };
  const listeners = {};
  const bridge = { enabled: true, linkId: 'link-exampleagent', mediaGrants: { microphone: true, speaker: true } };
  const state = { data: {
    settings: { desktopBridge: bridge },
    agents: [{ id: 'agent-exampleagent', name: 'ExampleAgent', accountLabel: 'Muse' }],
    agentLinks: [
      { id: 'link-exampleagent', agentId: 'agent-exampleagent', status: 'offline', authorizationStatus: 'connected', identity: { name: 'ExampleAgent', provider: 'Muse' }, capabilities: ['messages'], grantedCapabilities: ['microphone-listen', 'speaker-output', 'camera-view'] },
      { id: 'link-other', status: 'connected', identity: { name: 'Another agent', provider: 'Local' }, capabilities: ['messages'] }
    ]
  } };
  const document = {
    querySelector(selector) { return selector === '#callDirectoryList' ? list : selector === '#liveStatus' ? status : null; },
    addEventListener(type, callback) { listeners[type] = callback; }
  };
  const media = {
    state: () => ({ microphone: true, speaker: true }),
    prepareCallAudioFromGesture: () => { calls.push('browser-media-prompt'); return Promise.resolve(); },
    setKind: async (kind, enabled) => { calls.push(`media:${kind}:${enabled}`); },
    setMicrophoneMuted() {}, setVoicePlaybackMuted() {}, stop: async () => {}
  };
  const window = {
    HexiGridDesktopMedia: media,
    HexiGridIncomingVoiceCall: { hasLiveCall: () => false, openFloatingCallFromGesture: () => calls.push('open-floating-call'), update: (input) => calls.push(`call-ui:${input.voiceCall.status}`), requestCameraOnAnswer: callId => calls.push(`camera-on-answer:${callId}`) },
    addEventListener() {}
  };
  const api = async (pathname, options = {}) => {
    calls.push(`api:${pathname}`);
    if (pathname === '/api/settings') {
      const patch = JSON.parse(options.body);
      if (!ignoreContactSave) state.data.settings = { ...state.data.settings, ...patch };
      return { settings: state.data.settings };
    }
    if (pathname === '/api/desktop-bridge') return { bridge };
    if (pathname === '/api/desktop-bridge/voice-call/start') {
      callRequests.push(JSON.parse(options.body));
      return { voiceCall: { id: 'call-1', linkId: 'link-exampleagent', direction: 'owner-to-agent', status: 'offered' } };
    }
    throw new Error(`Unexpected call: ${pathname}`);
  };
  vm.runInNewContext(source, { document, window, state, api, notify: (...args) => notifications.push(args), location: { search: '' }, URLSearchParams, setTimeout() {}, clearTimeout, Date, String, Number, Boolean, Math, Promise, console });
  window.HexiGridLiveCall.renderCallDirectory();
  assert.match(list.innerHTML, /ExampleAgent/);
  assert.match(list.innerHTML, /data-call-start="link-exampleagent"/);
  assert.match(list.innerHTML, /data-call-video="true"[^>]*aria-label="Video call ExampleAgent"/);
  assert.doesNotMatch(list.innerHTML, /data-call-start="link-exampleagent" disabled/);
  assert.match(list.innerHTML, /Paired · Ready to call/);
  assert.doesNotMatch(list.innerHTML, /Reconnect this agent to call/);
  assert.match(list.innerHTML, /data-call-start="link-other" disabled/);

  const target = { dataset: { callStart: 'link-exampleagent' } };
  listeners.click({ target: { closest: selector => selector === '[data-call-start]' ? target : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 5), [
    'browser-media-prompt', 'open-floating-call', 'api:/api/desktop-bridge',
    'api:/api/desktop-bridge/voice-call/start', 'call-ui:offered'
  ]);
  assert.ok(calls.includes('call-ui:offered'));
  assert.ok(!calls.some(call => call.startsWith('camera-on-answer:')));
  assert.equal(callRequests.at(-1).video, false);
  target.dataset.callVideo = 'true';
  listeners.click({ target: { closest: selector => selector === '[data-call-start]' ? target : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('camera-on-answer:call-1'));
  assert.equal(callRequests.at(-1).video, true);

  const pairedLink = state.data.agentLinks[0];
  for (const heartbeat of ['degraded', 'online', 'offline']) {
    pairedLink.status = heartbeat;
    window.HexiGridLiveCall.renderCallDirectory();
    assert.doesNotMatch(list.innerHTML, /data-call-start="link-exampleagent" disabled/);
  }
  const permissions = pairedLink.grantedCapabilities;
  pairedLink.grantedCapabilities = ['microphone-listen'];
  window.HexiGridLiveCall.renderCallDirectory();
  assert.match(list.innerHTML, /data-call-start="link-exampleagent" disabled/);
  pairedLink.grantedCapabilities = permissions;
  bridge.enabled = false;
  window.HexiGridLiveCall.renderCallDirectory();
  assert.match(list.innerHTML, /data-call-start="link-exampleagent" disabled/);
  bridge.enabled = true;
  pairedLink.authorizationStatus = 'stale';
  window.HexiGridLiveCall.renderCallDirectory();
  assert.match(list.innerHTML, /data-call-start="link-exampleagent" disabled/);
  const attemptsBefore = calls.length;
  listeners.click({ target: { closest: selector => selector === '[data-call-start]' ? target : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, attemptsBefore, 'an invalid Link never starts capture or calls the API');
  pairedLink.authorizationStatus = 'revoked';
  window.HexiGridLiveCall.renderCallDirectory();
  assert.doesNotMatch(list.innerHTML, /data-call-start="link-exampleagent"/);
  listeners.click({ target: { closest: selector => selector === '[data-call-start]' ? target : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, attemptsBefore, 'a revoked Link cannot start capture or calls');
  pairedLink.authorizationStatus = 'connected';
  window.HexiGridLiveCall.renderCallDirectory();

  const linkSnapshot = JSON.stringify(state.data.agentLinks);
  await window.HexiGridLiveCall.setContactVisibility('link-other', false);
  assert.deepEqual([...state.data.settings.hiddenCallContacts], ['link-other']);
  assert.doesNotMatch(list.innerHTML, /data-call-start="link-other"/);
  assert.match(list.innerHTML, /data-call-start="link-exampleagent"/);
  window.HexiGridLiveCall.renderCallDirectory();
  assert.doesNotMatch(list.innerHTML, /data-call-start="link-other"/, 'refresh respects the saved workspace preference');
  await window.HexiGridLiveCall.setContactVisibility('link-other', true);
  assert.match(list.innerHTML, /data-call-start="link-other"/);
  assert.equal(JSON.stringify(state.data.agentLinks), linkSnapshot, 'removing/restoring a contact cannot change its Link or capabilities');
  ignoreContactSave = true;
  await window.HexiGridLiveCall.setContactVisibility('link-other', false);
  assert.match(list.innerHTML, /data-call-start="link-other"/);
  assert.match(notifications.at(-1)[0], /was not saved/, 'a server that ignores the preference cannot report success');
});
