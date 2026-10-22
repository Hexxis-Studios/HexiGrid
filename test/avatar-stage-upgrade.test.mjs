import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('avatar attributes survive creation before the model custom element upgrades', async () => {
  const attributes = new Map(), events = new Map();
  let plays = 0, pauses = 0, poll;
  const model = {
    dataset: {}, loaded: false,
    availableAnimations: [], getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    addEventListener: (name, callback) => events.set(name, callback), paused: true,
    play() { plays++; this.paused = false; }, pause() { pauses++; this.paused = true; }
  };
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', innerHTML: '', dataset: {}, style: {}, querySelector: () => model });
    return elements.get(selector);
  };
  const profile = { id: 'qa', name: 'QA', avatarModel: { url: '/api/media/qa' } };
  const avatar = { visible: true, yaw: 45, scale: 1, animation: 'Crouch', playing: true, state: 'idle', revision: 1 };
  const context = vm.createContext({
    state: { activeView: 'integrations', data: { agents: [profile] } },
    document: { querySelector: element, addEventListener() {} },
    window: { HexiGridAvatarViewer: { element: () => '<model-viewer></model-viewer>' } },
    api: async () => ({ avatar }), agent: () => profile, escapeHtml: String, initials: () => 'Q',
    agentListLabel: item => item.name, setInterval: fn => { poll = fn; return 1; }
  });
  vm.runInContext(await readFile(new URL('../public/avatar-stage.js', import.meta.url), 'utf8'), context);
  context.window.HexiGridAvatarStage.render();
  await new Promise(setImmediate);
  assert.equal(attributes.get('orientation'), '0deg 0deg 45deg');
  assert.equal(attributes.get('scale'), '1 1 1');
  for (const name of ['orientation', 'scale', 'animationName']) assert.equal(Object.hasOwn(model, name), false, `${name} must not shadow an upgraded accessor`);
  assert.equal(element('#avatarStageStatus').textContent, 'Loading 3D avatar…');
  model.availableAnimations = ['Idle', 'Crouch'];
  model.availableExpressions = ['happy'];
  model.loaded = true;
  events.get('load')();
  assert.equal(attributes.get('animation-name'), 'Crouch');
  assert.equal(element('#avatarStageAnimation').value, 'Crouch');
  assert.equal(element('#avatarStageExpressionLabel').hidden, false);
  assert.equal(element('#avatarStageExpression').value, '');
  assert.equal(plays, 1);
  poll();
  await new Promise(setImmediate);
  assert.equal(plays, 1, 'an unchanged status poll must not restart a running clip');
  avatar.playing = false;
  poll();
  await new Promise(setImmediate);
  assert.equal(pauses, 1);
  poll();
  await new Promise(setImmediate);
  assert.equal(pauses, 1, 'paused status polls must leave playback alone');
  avatar.playing = true;
  poll();
  await new Promise(setImmediate);
  assert.equal(plays, 2, 'an explicit resume starts playback once');
  events.get('error')();
  const failure = element('#avatarStageStatus').textContent;
  assert.match(failure, /Model could not load/);
  poll();
  await new Promise(setImmediate);
  assert.equal(element('#avatarStageStatus').textContent, failure, 'status refresh must retain actionable model failure');
});

test('2D pose leaves the frame fixed, image failures persist and switching to 3D clears the pose', async () => {
  const events = new Map(), image = { dataset: {}, style: {}, addEventListener: (name, fn) => events.set(name, fn) };
  const model = { dataset: {}, style: {}, paused: true, availableAnimations: [], addEventListener() {}, getAttribute() {}, setAttribute() {}, removeAttribute() {}, play() {} };
  const profile = { id: 'qa', name: 'QA', avatarImage: '/icon-192.png' };
  const avatar = { visible: true, yaw: 45, scale: 1, state: 'idle', revision: 0, playing: true };
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', innerHTML: '', dataset: {}, style: {}, querySelector: name => name === 'img' && !profile.avatarModel ? image : name === 'model-viewer' && profile.avatarModel ? model : null });
    return elements.get(selector);
  };
  let poll;
  const context = vm.createContext({ state: { activeView: 'integrations', data: { agents: [profile] } }, document: { querySelector: element, addEventListener() {} }, window: { HexiGridAvatarViewer: { element: () => '<model-viewer></model-viewer>' } }, api: async () => ({ avatar }), agent: () => profile, escapeHtml: String, initials: () => 'Q', agentListLabel: item => item.name, setInterval: fn => { poll = fn; return 1; } });
  vm.runInContext(await readFile(new URL('../public/avatar-stage.js', import.meta.url), 'utf8'), context);
  context.window.HexiGridAvatarStage.render();
  await new Promise(setImmediate);
  assert.equal(element('#avatarStageBody').style.transform, '');
  assert.equal(image.style.transform, 'rotateY(45deg) scale(1)');
  events.get('error')();
  poll(); await new Promise(setImmediate);
  assert.match(element('#avatarStageStatus').textContent, /Image could not load/);
  events.get('load')();
  assert.match(element('#avatarStageStatus').textContent, /2D image/);
  profile.avatarModel = { url: '/api/media/qa' };
  poll(); await new Promise(setImmediate);
  assert.equal(element('#avatarStageBody').style.transform, '');
  assert.match(element('#avatarStageStatus').textContent, /Loading 3D avatar/);
});
