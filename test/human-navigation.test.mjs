import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
test('human destinations accept known hashes and reject arbitrary selectors', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function viewFromHash(');
  const end = source.indexOf('\nfunction showView(', start);
  const context = vm.createContext({ document: { getElementById: id => ['view-overview','view-agents','view-memory','view-tasks'].includes(id) ? {} : null } });
  vm.runInContext(source.slice(start, end), context);
  for (const name of ['agents','memory','tasks']) assert.equal(context.viewFromHash(`#${name}`), name);
  for (const hash of ['', '#missing', '#agents?delete=true', '#../settings', '#<script>']) assert.equal(context.viewFromHash(hash), 'overview');
  assert.match(source, /history\.pushState\(null, '', `#\$\{view\}`\)/);
  assert.match(source, /addEventListener\('hashchange'/);
});

test('delayed authentication restores the requested destination once without moving an active view', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function refresh() {');
  const end = source.indexOf('\ndocument.addEventListener("click"', start);
  let unavailable = true, authPrompts = 0, destination = 'overview';
  const history = [];
  const context = vm.createContext({
    state: { data: null }, memoryLearningResumePending: false, memoryLearningResumeMessage: '',
    window: { location: { hash: '#usage' }, showAuthGate: () => authPrompts++ },
    document: { body: { classList: { toggle() {} } } },
    api: async () => { if (unavailable) throw Object.assign(new Error('Sign in'), { status: 401, body: {authRequired: true} }); return { settings: {} }; },
    isStandaloneBrowser: () => false, activeRoom: () => true, renderAll() {}, loadNetwork: async () => {}, startRoomEvents() {}, startIncomingVoiceCallMonitor() {},
    viewFromHash: hash => hash === '#usage' ? 'usage' : 'overview',
    showView: (view, options) => { destination = view; history.push(options.updateHistory); }, notify() {}
  });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(await context.refresh(), false); assert.equal(authPrompts, 1); assert.equal(destination, 'overview');
  unavailable = false;
  assert.equal(await context.refresh(), true); assert.equal(destination, 'usage'); assert.deepEqual(history, [false]);
  destination = 'memory';
  assert.equal(await context.refresh(), true); assert.equal(destination, 'memory'); assert.deepEqual(history, [false]);
});
