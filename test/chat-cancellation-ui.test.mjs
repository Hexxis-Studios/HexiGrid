import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('room reply stays busy after saving, rejects duplicate send, and Stop retains saved input', async () => {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, focus() {} });
    return nodes.get(id);
  };
  const room = { id: 'room', name: 'QA', agentIds: ['agent'], messages: [] };
  const person = { id: 'agent', name: 'QA responder' };
  let started;
  const responding = new Promise((resolve) => { started = resolve; });
  const calls = [];
  const state = { data: { rooms: [room], agents: [person] }, activeRoomId: room.id, chatTurn: null };
  const context = vm.createContext({ state, $, $$: () => [], document: { querySelector: $ },
    AbortController, crypto: { randomUUID }, activeRoom: () => room, agent: () => person,
    escapeHtml: (value) => String(value), colorTile: () => '', agentListLabel: (item) => item.name,
    initials: () => 'Q', timeAgo: () => 'now', modelInfo: () => null, notify() {},
    api: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/messages/user')) { room.messages.push({ role: 'user', content: JSON.parse(options.body).content }); return { room }; }
      if (url.endsWith('/messages')) return new Promise((_resolve, reject) => { started(); options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); });
      if (url.endsWith('/stop')) return { stopped: true };
      if (url === '/api/rooms') return { rooms: [room] };
      throw new Error('Unexpected API');
    }, DOMException });
  context.renderAll = () => context.renderRooms();
  vm.runInContext(await readFile(new URL('../public/chat-ui.js', import.meta.url), 'utf8'), context);
  $('#chatInput').value = 'Harmless QA';
  const sending = context.sendChat({ preventDefault() {} });
  await responding;
  assert.equal($('#chatForm button[type=\'submit\']').disabled, true);
  assert.equal($('#chatInput').disabled, true);
  assert.equal($('#chatStop').hidden, false);
  await context.sendChat({ preventDefault() {} });
  assert.equal(calls.filter((call) => call.url.endsWith('/messages/user')).length, 1);
  const requestId = state.chatTurn.requestId;
  await context.stopChat();
  await sending;
  assert.equal(state.chatTurn, null);
  assert.equal($('#chatStop').hidden, true);
  assert.equal($('#chatInput').value, '');
  assert.equal(room.messages.length, 1);
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith('/stop')).options.body).requestId, requestId);
});

test('an aborted owner request never activates standalone fallback', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function api(');
  const end = source.indexOf('async function refreshIncomingVoiceCall', start);
  assert.ok(start >= 0 && end > start, 'exercise only the actual request helper');
  let fallback = 0;
  const controller = new AbortController(); controller.abort();
  const context = vm.createContext({ isStandaloneBrowser: () => false, document: { cookie: '' }, navigator: { onLine: true },
    window: { HexiGridStandalone: { activate() { fallback++; }, request() { fallback++; } } },
    fetch: async () => { throw new DOMException('Stopped', 'AbortError'); }, DOMException });
  vm.runInContext(source.slice(start, end), context);
  await assert.rejects(() => context.api('/api/rooms/qa/messages', { signal: controller.signal }), /Stopped/);
  assert.equal(fallback, 0);
});

test('unsent drafts follow their room through switching and background rerenders', async () => {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, focus() {} });
    return nodes.get(id);
  };
  const rooms = ['one', 'two'].map((id) => ({ id, name: id, messages: [], agentIds: [] }));
  const state = { data: { rooms, agents: [] }, activeRoomId: 'one', chatTurn: null };
  const context = vm.createContext({ state, $, document: { querySelector: $ },
    activeRoom: () => rooms.find((room) => room.id === state.activeRoomId), escapeHtml: String,
    agent: () => null, agentListLabel: (item) => item.name, initials: () => '', timeAgo: () => '' });
  vm.runInContext(await readFile(new URL('../public/chat-ui.js', import.meta.url), 'utf8'), context);
  context.renderRooms();
  $('#chatInput').value = 'Draft for room one';
  state.activeRoomId = 'two'; context.renderRooms();
  assert.equal($('#chatInput').value, '');
  $('#chatInput').value = 'Draft for room two';
  context.renderRooms();
  assert.equal($('#chatInput').value, 'Draft for room two');
  state.chatTurn = { roomId: 'one', saved: true };
  context.renderRooms();
  assert.equal($('#chatInput').value, 'Draft for room two');
  assert.equal($('#chatInput').disabled, false);
  state.activeRoomId = 'one'; context.renderRooms();
  assert.equal($('#chatInput').value, 'Draft for room one');
  assert.equal($('#chatInput').disabled, true);
  state.chatTurn = null; state.activeRoomId = 'two'; context.renderRooms();
  assert.equal($('#chatInput').value, 'Draft for room two');
});

test('browser-local inference shows bounded preparation progress without exposing engine details', async () => {
  const input = { value: 'Say only READY.', focus() {} };
  let hintText = '';
  const hint = Object.defineProperty({}, 'textContent', { get: () => hintText, set: (value) => { hintText = value; } });
  const nodes = new Map([['#chatInput', input], ['#composerHint', hint]]);
  const $ = (selector) => nodes.get(selector) || (nodes.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false }), nodes.get(selector));
  const room = { id: 'room', name: 'QA', agentIds: ['local'], messages: [] };
  const otherRoom = { id: 'other', name: 'Other', agentIds: ['local'], messages: [] };
  const person = { id: 'local', name: 'Local QA', transport: 'local-opencode', model: 'browser-model' };
  const state = { data: { rooms: [room, otherRoom], agents: [person], settings: {}, memories: [] }, activeRoomId: room.id, chatTurn: null };
  const receivedErrors = [];
  const context = vm.createContext({ state, $, $$: () => [], document: { querySelector: $ }, AbortController, crypto: { randomUUID },
    activeRoom: () => room, agent: () => person, escapeHtml: String, colorTile: () => '', agentListLabel: (item) => item.name,
    initials: () => 'Q', timeAgo: () => 'now', modelInfo: () => ({ browser: true, remoteModel: 'SmolLM2-135M-Instruct-q0f16-MLC', label: 'This device / SmolLM2-135M-Instruct-q0f16-MLC', modelMeta: { label: 'SmolLM2 135M Instruct q0f16' } }), notify() {},
    window: { HexiGridBrowserChat: { async completeTurn({ onProgress }) {
      onProgress({ generating: true, text: 'partial cached output' });
      assert.match(hintText, /Generating locally with SmolLM2 135M Instruct q0f16/);
      onProgress({ text: 'https://model-host.invalid/private-runtime-detail', progress: 0.426 });
      assert.match(hintText, /Preparing SmolLM2 135M Instruct q0f16 · 43%/);
      onProgress({ generating: true, text: 'partial output' });
      assert.match(hintText, /Generating locally with SmolLM2 135M Instruct q0f16/);
      return { content: 'READY', inputTokens: null, outputTokens: null };
    } } },
    api: async (url, options = {}) => {
      if (url.endsWith('/messages/user')) { room.messages.push({ role: 'user', content: JSON.parse(options.body).content }); return { room }; }
      if (url.endsWith('/messages/browser')) { const body = JSON.parse(options.body); receivedErrors.push(body.error || ''); room.messages.push({ role: 'agent', content: body.content }); return { room, replies: [] }; }
      throw new Error(`Unexpected API route ${url}`);
    }, DOMException });
  vm.runInNewContext(await readFile(new URL('../public/chat-ui.js', import.meta.url), 'utf8'), context);
  context.renderRooms = () => {};
  context.renderAll = () => {};
  await context.sendChat({ preventDefault() {} });
  assert.equal(state.chatTurn, null);
  assert.equal(receivedErrors[0], '');
  assert.equal(room.messages.at(-1).content, 'READY');
  assert.doesNotMatch(hintText, /model-host|private-runtime-detail|partial output/);
});

test('failed browser-local inference becomes a visible recovery notice without cloud fallback', async () => {
  const input = { value: 'Say only READY.', focus() {} };
  const nodes = new Map([['#chatInput', input]]);
  const $ = (selector) => nodes.get(selector) || (nodes.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false }), nodes.get(selector));
  const room = { id: 'room', name: 'QA', agentIds: ['local'], messages: [] };
  const otherRoom = { id: 'other', name: 'Other', agentIds: ['local'], messages: [] };
  const person = { id: 'local', name: 'Local QA', transport: 'local-opencode', model: 'browser-model' };
  const state = { data: { rooms: [room, otherRoom], agents: [person], settings: {}, memories: [] }, activeRoomId: room.id, chatTurn: null };
  const routes = [];
  const recovery = 'The browser could not download or prepare the local model. Check your connection and available storage, then retry or choose a smaller model. HexiGrid will not send your prompt to a cloud model automatically.';
  const context = vm.createContext({ state, $, $$: () => [], document: { querySelector: $ }, AbortController, crypto: { randomUUID },
    activeRoom: () => state.data.rooms.find((item) => item.id === state.activeRoomId), agent: () => person, escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    colorTile: () => '', agentListLabel: (item) => item.name, initials: () => 'Q', timeAgo: () => 'now',
    modelInfo: () => ({ browser: true, remoteModel: 'SmolLM2-135M-Instruct-q0f16-MLC', label: 'This device / SmolLM2-135M-Instruct-q0f16-MLC', modelMeta: { label: 'SmolLM2 135M Instruct q0f16' } }),
    notify() {}, window: { HexiGridBrowserChat: { async completeTurn() { state.activeRoomId = otherRoom.id; throw new Error(recovery); } } },
    api: async (url, options = {}) => {
      routes.push(url);
      if (url.endsWith('/messages/user')) { room.messages.push({ role: 'user', author: 'You', content: JSON.parse(options.body).content }); return { room }; }
      if (url.endsWith('/messages/browser')) {
        const body = JSON.parse(options.body);
        room.messages.push({ role: 'system', author: person.name, agentId: person.id, content: `On-device model unavailable: ${body.error}`, delivery: 'local-only' });
        return { room, replies: [] };
      }
      throw new Error(`Unexpected fallback route ${url}`);
    }, DOMException });
  vm.runInNewContext(await readFile(new URL('../public/chat-ui.js', import.meta.url), 'utf8'), context);
  context.renderAll = () => context.renderRooms();
  await context.sendChat({ preventDefault() {} });
  assert.equal(input.value, '', 'a failure in the prior room does not replace the selected room draft');
  state.activeRoomId = room.id;
  context.renderRooms();
  const rendered = nodes.get('#messageList').innerHTML;
  assert.deepEqual(routes, ['/api/rooms/room/messages/user', '/api/rooms/room/messages/browser']);
  assert.match(rendered, /On-device model unavailable/);
  assert.match(rendered, /Check your connection and available storage/);
  assert.match(rendered, /will not send your prompt to a cloud model automatically/);
  assert.doesNotMatch(rendered, /huggingface|private-runtime-detail|partial output/i);
  assert.equal(room.messages[0].role, 'user');
  assert.equal(room.messages[0].content, 'Say only READY.');
  assert.equal(room.messages.at(-1).role, 'system');
  assert.equal(room.messages.at(-1).delivery, 'local-only');
  assert.equal(input.value, 'Say only READY.');
  assert.match(nodes.get('#composerHint').textContent, /previous prompt is saved above.*composer keeps a retry draft/i);
});

test('a local reply save failure preserves escaped output and retries saving without inference or a false model error', async () => {
  const nodes = new Map();
  const $ = selector => nodes.get(selector) || (nodes.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, focus() {} }), nodes.get(selector));
  const room = { id: 'room', name: 'QA', agentIds: ['local'], messages: [] };
  const other = { id: 'other', name: 'Other', agentIds: [], messages: [] };
  const person = { id: 'local', name: 'Local QA', transport: 'local-opencode', model: 'browser-model' };
  const state = { data: { rooms: [room, other], agents: [person], settings: {}, memories: [] }, activeRoomId: room.id, chatTurn: null };
  let generations = 0;
  const saves = [], notices = [];
  const context = vm.createContext({ state, $, document: { querySelector: $ }, AbortController, crypto: { randomUUID },
    activeRoom: () => state.data.rooms.find(item => item.id === state.activeRoomId), agent: () => person,
    escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), colorTile: () => '', agentListLabel: item => item.name, initials: () => 'Q', timeAgo: () => 'now',
    modelInfo: () => ({ browser: true, remoteModel: 'test-local' }), notify: text => notices.push(text),
    window: { HexiGridBrowserChat: { async completeTurn() { generations++; return { content: '<script>Harmless QA</script>', inputTokens: 2, outputTokens: 3 }; } } },
    api: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/messages/user')) { room.messages.push({ role: 'user', content: body.content }); return { room }; }
      assert.ok(url.endsWith('/messages/browser'), 'no cloud route is used');
      saves.push(body);
      if (saves.length <= 2) throw new Error('Local server disconnected');
      return { room: { ...room, messages: [...room.messages, { role: 'agent', content: body.content }] } };
    } });
  vm.runInContext(await readFile(new URL('../public/chat-ui.js', import.meta.url), 'utf8'), context);
  context.renderAll = () => context.renderRooms();
  $('#chatInput').value = 'Test';
  await context.sendChat({ preventDefault() {} });
  assert.equal(generations, 1);
  assert.equal(saves.length, 1, 'failed persistence is not submitted as a model failure');
  assert.equal(saves[0].error, undefined);
  assert.match($('#messageList').innerHTML, /save not confirmed.*&lt;script&gt;Harmless QA/s);
  assert.match($('#messageList').innerHTML, /Retry save/);
  assert.doesNotMatch($('#messageList').innerHTML, /<script>/);
  state.activeRoomId = other.id; context.renderRooms();
  assert.doesNotMatch($('#messageList').innerHTML, /Harmless QA/);
  await context.saveLocalReply(saves[0].replyId);
  assert.match(notices.at(-1), /still not confirmed/);
  state.activeRoomId = room.id; context.renderRooms();
  assert.match($('#messageList').innerHTML, /Retry save/);
  await context.saveLocalReply(saves[0].replyId);
  assert.equal(generations, 1);
  assert.equal(new Set(saves.map(body => body.replyId)).size, 1);
  assert.equal(room.messages.at(-1).content, '<script>Harmless QA</script>');
  assert.doesNotMatch($('#messageList').innerHTML, /Retry save|save not confirmed/);
  assert.match(notices.at(-1), /model was not run again/);
});
