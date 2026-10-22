import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [app, html, source] = await Promise.all([
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/incoming-voice-call.js', root), 'utf8')
]);

test('human shell polls the owner call state and connects it to the call renderer', () => {
  assert.match(html, /<script src="\/desktop-media\.js" defer><\/script>[\s\S]*<script src="\/incoming-voice-call\.js" defer><\/script>/);
  assert.match(app, /api\('\/api\/desktop-bridge'\)/);
  assert.match(app, /HexiGridIncomingVoiceCall\?\.update\(/);
  assert.match(app, /startIncomingVoiceCallMonitor\(\);/);
  assert.match(app, /setInterval\(\(\) => \{ void refreshIncomingVoiceCall\(\); \}, 1000\)/);
});

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.isConnected = false;
    this.textContent = '';
    this.className = '';
    this.id = '';
    this.listeners = {};
    this.dataset = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  append(...children) {
    this.children.push(...children);
    if (this.isConnected) for (const child of children) child.connect();
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  connect() { this.isConnected = true; for (const child of this.children) child.connect(); }
  show() { this.open = true; }
  close() { this.open = false; }
  querySelector(selector) {
    const match = (node) => selector.startsWith('#') ? node.id === selector.slice(1) : node.className.split(/\s+/).includes(selector.slice(1));
    for (const child of this.children) {
      if (match(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

test('a toast-accepted call exposes the persistent dock and audio recovery action without covering it with the ring dialog', async () => {
  const body = new Element('body');
  const document = {
    body,
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => body.querySelector(selector),
    addEventListener() {}
  };
  const media = {
    state: () => ({ microphone: false, speaker: false, speakerPlaybackBlocked: true, speakerAudioContextState: 'suspended', speakerPlaying: false }),
    stop: async () => {},
    setKind: async () => { throw new Error('Not expected without a browser microphone grant'); }
  };
  const window = { HexiGridDesktopMedia: media, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  const navigator = { permissions: { query: async () => ({ state: 'prompt' }) } };
  vm.runInNewContext(source, { document, window, navigator, Date, String, Number, Math, console, setTimeout, clearTimeout });
  window.HexiGridIncomingVoiceCall.update({
    request: async () => ({}),
    bridge: { enabled: true, linkId: 'link-qa' },
    voiceCall: { id: 'call-qa', linkId: 'link-qa', direction: 'agent-to-owner', status: 'active', acceptedVia: 'windows-toast', callerName: 'ExampleAgent QA', answeredAt: new Date().toISOString() },
    media: media.state()
  });
  await new Promise((resolve) => setImmediate(resolve));

  const dock = body.querySelector('.incoming-call-dock');
  const dialog = body.querySelector('#incomingVoiceCall');
  assert.ok(dock);
  assert.equal(dock.hidden, false);
  assert.equal(dock.querySelector('.incoming-call-dock__identity').children[0].textContent, 'ExampleAgent QA');
  assert.equal(dock.querySelector('.incoming-call-dock__audio').hidden, false);
  assert.equal(dialog.open, false);
  assert.ok(dock.querySelector('.incoming-call-dock__end'));
});

test('an owner-started call shows a calling dock and never opens the incoming-call prompt', () => {
  const body = new Element('body');
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  const media = { state: () => ({ microphone: true, speaker: true, speakerPlaybackBlocked: false, speakerAudioContextState: 'running', speakerPlaying: false }), stop: async () => {} };
  const window = { HexiGridDesktopMedia: media, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  const navigator = { permissions: { query: async () => ({ state: 'granted' }) } };
  vm.runInNewContext(source, { document, window, navigator, Date, String, Number, Math, console, setTimeout, clearTimeout });
  window.HexiGridIncomingVoiceCall.update({
    request: async () => ({}), bridge: { enabled: true, linkId: 'exampleagent-link' },
    voiceCall: { id: 'owner-call', linkId: 'exampleagent-link', direction: 'owner-to-agent', status: 'offered', callerName: 'ExampleAgent', offeredAt: new Date().toISOString() },
    media: media.state()
  });
  const dock = body.querySelector('.incoming-call-dock');
  assert.ok(dock);
  assert.equal(dock.hidden, false);
  assert.equal(dock.querySelector('.incoming-call-dock__identity').children[0].textContent, 'ExampleAgent');
  assert.match(dock.querySelector('.incoming-call-dock__identity').children[1].textContent, /waiting for your agent to answer/);
  assert.equal(body.querySelector('#incomingVoiceCall').open, false);
  assert.equal(window.HexiGridIncomingVoiceCall.hasLiveCall(), true);
});

test('multi-agent call controls show the selected agent and switch to an answered agent on hold', async () => {
  const body = new Element('body'); body.connect();
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  const events = [];
  const media = {
    state: () => ({ microphone: true, speaker: true, camera: false, speakerPlaybackBlocked: false, speakerAudioContextState: 'running' }),
    setMicrophoneMuted: muted => events.push(`microphone:${muted ? 'muted' : 'live'}`),
    setVoicePlaybackMuted: muted => events.push(`speaker:${muted ? 'muted' : 'live'}`),
    stop: async kind => events.push(`stop:${kind}`),
    prepareCallAudioFromGesture: async () => events.push('audio:prepared'),
    activateCallAudio: () => events.push('audio:active')
  };
  const agents = new Map([
    ['agent-a', { updatedAt: 'a1' }],
    ['agent-b', { updatedAt: 'b1' }]
  ]);
  const window = {
    HexiGridDesktopMedia: media,
    HexiGridLiveCall: {
      agentForLink: linkId => agents.get(linkId),
      nameForLink: linkId => ({ 'agent-a': 'ExampleAgent', 'agent-b': 'Luna' })[linkId],
      setStatus() {}
    },
    setInterval: () => 1, clearInterval() {}, addEventListener() {}
  };
  const navigator = { permissions: { query: async () => ({ state: 'granted' }) } };
  vm.runInNewContext(source, { document, window, navigator, Date, String, Number, Math, console, setTimeout, clearTimeout });

  const selected = {
    id: 'shared-call', linkId: 'agent-a', direction: 'owner-to-agent', status: 'active',
    participants: [
      { linkId: 'agent-a', status: 'active', onHold: false },
      { linkId: 'agent-b', status: 'active', onHold: true }
    ]
  };
  const bridgeFor = linkId => ({ enabled: true, linkId, mediaGrants: { camera: false } });
  const calls = [];
  const request = async (path, options) => {
    events.push('request:select');
    calls.push({ path, body: JSON.parse(options.body) });
    return {
      voiceCall: {
        ...selected, linkId: 'agent-b', participants: [
          { linkId: 'agent-a', status: 'active', onHold: true },
          { linkId: 'agent-b', status: 'active', onHold: false }
        ]
      },
      callBridge: bridgeFor('agent-b')
    };
  };
  window.HexiGridIncomingVoiceCall.update({ request, bridge: bridgeFor('agent-a'), voiceCall: selected, media: media.state() });

  let panel = body.querySelector('.hexi-call-participants');
  assert.ok(panel);
  assert.match(panel.children[0].children[0].textContent, /ExampleAgent · Talking/);
  assert.equal(panel.children[0].children[1].textContent, 'Selected');
  assert.equal(panel.children[0].children[1].disabled, true);
  assert.match(panel.children[1].children[0].textContent, /Luna · On hold/);
  assert.equal(panel.children[1].children[1].textContent, 'Talk');
  assert.equal(panel.children[1].children[1].disabled, false);

  events.length = 0;
  panel.children[1].children[1].listeners.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, [{ path: '/api/desktop-bridge/voice-call/select', body: { linkId: 'agent-b', approved: true } }]);
  assert.deepEqual(events, ['microphone:muted', 'speaker:muted', 'request:select', 'audio:prepared', 'audio:active', 'microphone:live', 'speaker:live']);
  panel = body.querySelector('.hexi-call-participants');
  assert.match(panel.children[0].children[0].textContent, /ExampleAgent · On hold/);
  assert.equal(panel.children[0].children[1].disabled, false);
  assert.match(panel.children[1].children[0].textContent, /Luna · Talking/);
  assert.equal(panel.children[1].children[1].textContent, 'Selected');
  assert.equal(panel.children[1].children[1].disabled, true);
});

test('only the selected call participant mounts an animated portrait; held participants keep static images', () => {
  const body = new Element('body'); body.connect();
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  const agents = new Map([
    ['agent-a', { id: 'profile-a', updatedAt: 'a1', avatarImage: 'data:image/png;base64,a', portraitAvatar: { idle: 'a-idle' } }],
    ['agent-b', { id: 'profile-b', updatedAt: 'b1', avatarImage: 'data:image/png;base64,b', portraitAvatar: { idle: 'b-idle' } }]
  ]);
  const mounted = [], stopped = [];
  const window = {
    HexiGridDesktopMedia: { state: () => ({ microphone: true, speaker: true, camera: false }) },
    HexiGridLiveCall: {
      agentForLink: linkId => agents.get(linkId),
      nameForLink: linkId => ({ 'agent-a': 'ExampleAgent', 'agent-b': 'Luna' })[linkId]
    },
    HexiGridPortraitAvatar: { mount: (container, avatar, options) => {
      mounted.push({ avatar, label: options.label, image: container.children[0]?.src });
      return { stop: () => stopped.push(options.label) };
    } },
    setInterval: () => 1, clearInterval() {}, addEventListener() {}
  };
  const navigator = { permissions: { query: async () => ({ state: 'granted' }) } };
  vm.runInNewContext(source, { document, window, navigator, Date, String, Number, Math, console, setTimeout, clearTimeout });
  const bridge = linkId => ({ enabled: true, linkId });
  const call = (selectedLinkId, heldLinkId) => ({
    id: 'avatar-call', linkId: selectedLinkId, direction: 'owner-to-agent', status: 'active',
    participants: [
      { linkId: selectedLinkId, status: 'active', onHold: false },
      { linkId: heldLinkId, status: 'active', onHold: true }
    ]
  });

  window.HexiGridIncomingVoiceCall.update({ request: async () => ({}), bridge: bridge('agent-a'), voiceCall: call('agent-a', 'agent-b') });
  let panel = body.querySelector('.hexi-call-participants');
  assert.equal(panel.children[0].children[0].children[0].src, 'data:image/png;base64,a');
  assert.equal(panel.children[1].children[0].children[0].src, 'data:image/png;base64,b');
  assert.deepEqual(mounted, [{ avatar: { idle: 'a-idle' }, label: 'ExampleAgent animated portrait', image: 'data:image/png;base64,a' }]);

  window.HexiGridIncomingVoiceCall.update({ bridge: bridge('agent-b'), voiceCall: call('agent-b', 'agent-a') });
  panel = body.querySelector('.hexi-call-participants');
  assert.equal(stopped[0], 'ExampleAgent animated portrait');
  assert.deepEqual(mounted.map(item => item.label), ['ExampleAgent animated portrait', 'Luna animated portrait']);
  assert.match(panel.children[0].children[1].textContent, /Luna · Talking/);
  assert.match(panel.children[1].children[1].textContent, /ExampleAgent · On hold/);
});

test('call avatar uses exact linked profile, permits 2D/3D switching and clears visuals on end', async () => {
  const body = new Element('body'); body.connect();
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  const asset = { id: 'linked-profile', avatarImage: 'data:image/png;base64,synthetic', avatarModel: { url: '/api/agents/linked-profile/avatar-model', format: 'vrm' } };
  const previews = [];
  const upgraded = [];
  const window = { HexiGridDesktopMedia: { state: () => ({ camera: true, microphone: true, speaker: true, speakerAudioContextState: 'running' }), attachCameraPreview: el => { el.srcObject = 'same-approved-stream'; previews.push(el); }, stop: async () => {} },
    HexiGridLiveCall: { agentForLink: id => id === 'exact-link' ? asset : null },
    HexiGridAvatarViewer: { element: (url, label, kind, format) => `${format}:${url}`, ensureVrmLoaded: async () => {} }, customElements: { upgrade: element => upgraded.push(element) }, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  vm.runInNewContext(source, { document, window, navigator: {}, Date, String, Number, Math, Map, console, setTimeout, clearTimeout });
  const update = status => window.HexiGridIncomingVoiceCall.update({ request: async () => ({}), bridge: { enabled: true, linkId: 'exact-link' }, voiceCall: { id: 'same-call', linkId: 'exact-link', status, direction: 'owner-to-agent' } });
  update('active');
  const stage = body.querySelector('.hexi-call-video');
  const view = stage.querySelector('.hexi-call-agent-view');
  assert.equal(view.innerHTML, 'vrm:/api/agents/linked-profile/avatar-model');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upgraded[0], view.children[0], 'construct and upgrade through the owner registry before floating adoption');
  assert.equal(view.children[0].tagName, 'HEXI-VRM-VIEWER');
  const choose = stage.querySelector('.hexi-call-video-tools').children[0];
  assert.equal(choose.hidden, false); choose.value = '2d'; choose.listeners.change();
  assert.equal(view.children[0].tagName, 'IMG');
  assert.equal(view.children[0].src, asset.avatarImage);
  assert.equal(previews[0].srcObject, 'same-approved-stream');
  update('ended');
  assert.equal(stage.hidden, true);
  assert.equal(previews[0].srcObject, null);
  assert.equal(view.children.length, 0);
});

test('toast acceptance starts only already-authorized capture; audio context resume is reserved for the in-page click', () => {
  const start = source.slice(source.indexOf('async function startPreauthorizedToastCallAudio'), source.indexOf('\n  function setBusy', source.indexOf('async function startPreauthorizedToastCallAudio')));
  assert.match(start, /media\.setKind\('microphone', true/);
  assert.match(start, /media\.setKind\('speaker', true/);
  assert.doesNotMatch(start, /await enableCallAudio\(\)|prepareSpeakerPlayback/);
  assert.match(source, /enableAudio\.addEventListener\('click',[^\n]*acceptCall\(\) : enableDockCallAudio\(\)/);
});

test('Windows is the sole popup; the browser fallback answers the same call and disappears after toast acceptance', async () => {
  const body = new Element('body'); body.connect();
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  const state = { microphone: true, speaker: true, speakerPlaybackBlocked: false, speakerAudioContextState: 'running' };
  const media = { state: () => state, setKind: async () => {}, setMicrophoneMuted() {}, setVoicePlaybackMuted() {}, stop: async () => {} };
  const window = { HexiGridDesktopMedia: media, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  const navigator = { permissions: { query: async () => ({ state: 'granted' }) } };
  vm.runInNewContext(source, { document, window, navigator, Date, String, Number, Math, console, setTimeout, clearTimeout });
  const update = voiceCall => window.HexiGridIncomingVoiceCall.update({ request: async () => { throw Error('No second acceptance request expected'); }, bridge: { enabled: true, linkId: 'link' }, voiceCall, media: state });
  const ringing = { id: 'call', linkId: 'link', direction: 'agent-to-owner', status: 'ringing', callerName: 'Agent', notificationChannel: 'windows' };
  update(ringing);
  const dock = body.querySelector('.incoming-call-dock'), dialog = body.querySelector('#incomingVoiceCall');
  assert.equal(dialog.open, false); assert.equal(dock.hidden, false);
  assert.equal(dock.querySelector('.incoming-call-dock__identity').children[1].textContent, 'Answer here or from the Windows alert');
  assert.equal(dock.querySelector('.incoming-call-dock__audio').textContent, 'Answer');
  assert.equal(dock.querySelector('.incoming-call-dock__end').textContent, 'Decline');
  update({ ...ringing, status: 'active', acceptedVia: 'windows-toast' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, false); assert.equal(dock.querySelector('.incoming-call-dock__audio').hidden, true);
  assert.equal(dock.querySelector('.incoming-call-dock__end').textContent, 'End');
  update({ ...ringing, id: 'fallback', notificationChannel: 'browser' });
  assert.equal(dialog.open, true, 'native notification failure retains the browser call prompt');
});

test('an expired incoming call closes its browser prompt and stops its media tracks', async () => {
  const body = new Element('body'); body.connect();
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  const stopped = [];
  const media = { state: () => ({}), stop: async kind => { stopped.push(kind); } };
  const window = { HexiGridDesktopMedia: media, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  const navigator = { permissions: { query: async () => ({ state: 'prompt' }) } };
  vm.runInNewContext(source, { document, window, navigator, Date, String, Number, Math, Map, console, setTimeout, clearTimeout });
  const update = voiceCall => window.HexiGridIncomingVoiceCall.update({
    request: async () => ({}), bridge: { enabled: true, linkId: 'expired-link' }, voiceCall, media: media.state()
  });
  update({ id: 'expired-call', linkId: 'expired-link', direction: 'agent-to-owner', status: 'ringing', notificationChannel: 'browser' });
  const dialog = body.querySelector('#incomingVoiceCall');
  const dock = body.querySelector('.incoming-call-dock');
  assert.equal(dialog.open, true);
  assert.equal(dock.hidden, false);

  update({ id: 'expired-call', linkId: 'expired-link', direction: 'agent-to-owner', status: 'ended', stopReason: 'missed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, false);
  assert.equal(dock.hidden, true);
  assert.equal(window.HexiGridIncomingVoiceCall.hasLiveCall(), false);
  assert.deepEqual(stopped, ['microphone', 'speaker', 'camera']);
});

test('camera switches inside the same accepted call without restarting or ending audio', async () => {
  const body = new Element('body');
  body.connect();
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), addEventListener() {} };
  let camera = false;
  const switches = [];
  const media = { state: () => ({ camera, microphone: true, speaker: true, speakerAudioContextState: 'running' }),
    setKind: async (kind, enabled) => { switches.push([kind, enabled]); camera = enabled; }, stop: async () => {} };
  const window = { HexiGridDesktopMedia: media, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  vm.runInNewContext(source, { document, window, navigator: {}, Date, String, Number, Math, console, setTimeout, clearTimeout });
  const requests = [];
  window.HexiGridIncomingVoiceCall.update({ request: async path => { requests.push(path); return {}; }, bridge: { enabled: true, linkId: 'camera-link' },
    voiceCall: { id: 'same-call', linkId: 'camera-link', status: 'active', direction: 'owner-to-agent' }, media: media.state() });
  const cameraButton = body.querySelector('.incoming-call-dock__camera');
  assert.equal(cameraButton.textContent, 'Video on');
  cameraButton.listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(switches, [['camera', true]]);
  assert.equal(cameraButton.textContent, 'Video off');
  assert.equal(body.querySelector('.hexi-call-video').hidden, false);
  cameraButton.listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cameraButton.textContent, 'Video on');
  assert.equal(body.querySelector('.hexi-call-video').hidden, true);
  assert.deepEqual(switches, [['camera', true], ['camera', false]]);
  assert.deepEqual(requests, []);
  assert.equal(window.HexiGridIncomingVoiceCall.hasLiveCall(), true);
});
