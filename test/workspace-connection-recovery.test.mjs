import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('human and agent requests never switch vaults or replay after transport failure', async () => {
  const human = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const agent = await readFile(new URL('../public/agent-interface.js', import.meta.url), 'utf8');
  for (const [name, source] of [
    ['api', human.slice(human.indexOf('class ApiError'), human.indexOf('async function refreshIncomingVoiceCall'))],
    ['request', agent.slice(agent.indexOf('  async function request('), agent.indexOf('  function connectedLinks('))]
  ]) {
    let fallbacks = 0, calls = 0;
    const context = vm.createContext({ document: { cookie: '' }, navigator: { onLine: true }, isStandaloneBrowser: () => false, csrfToken: () => '',
      window: { HexiGridStandalone: { isActive: () => false, activate: () => { fallbacks++; }, request: () => { fallbacks++; } }, HexiGridConnectivity: { markOffline() {} } },
      fetch: async () => { calls++; throw new TypeError('disconnected'); } });
    vm.runInContext(source, context);
    await assert.rejects(context[name]('/api/agents', { method: 'POST', body: '{}' }), error => error.status === 503 && /not retried/.test(error.message));
    assert.equal(calls, 1);
    assert.equal(fallbacks, 0);
    const signal = { aborted: true };
    await assert.rejects(context[name]('/api/agents', { signal }), /disconnected/);
    assert.equal(fallbacks, 0);
  }
});

test('standalone detection requires positive static discovery and never a missing write route', async () => {
  const context = vm.createContext({ window: {}, crypto: {}, navigator: {}, URL });
  vm.runInContext(await readFile(new URL('../public/standalone-runtime.js', import.meta.url), 'utf8'), context);
  const fallback = context.window.HexiGridStandalone.shouldFallback;
  assert.equal(fallback({ status: 404 }, '<html/>', 'text/html', '/api/auth/status', 'GET'), true);
  assert.equal(fallback({ status: 405 }, '', 'text/html', '/api/bootstrap', 'GET'), true);
  for (const [status, type, path, method] of [[503, 'text/html', '/api/auth/status', 'GET'], [404, 'application/json', '/api/auth/status', 'GET'], [404, 'text/html', '/api/agents', 'POST'], [404, 'text/html', '/api/auth/login', 'POST'], [404, 'text/html', '/api/agents', 'GET']]) {
    assert.equal(fallback({ status }, '', type, path, method), false);
  }
});

test('reconnect before auth discovery always offers local unlock instead of toggling it away', async () => {
  const source = await readFile(new URL('../public/auth-ui.js', import.meta.url), 'utf8');
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, { classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, force) {
          const next = force === undefined ? !classes.has(value) : Boolean(force);
          if (next) classes.add(value); else classes.delete(value);
        }
      }, addEventListener() {} });
    }
    return elements.get(selector);
  };
  const context = vm.createContext({ window: {}, document: { querySelector: element, body: element('body') }, isStandaloneBrowser: () => false });
  vm.runInContext(source.slice(0, source.indexOf('async function initAuth()')), context);
  for (let attempt = 0; attempt < 3; attempt++) {
    context.window.showAuthGate(false);
    assert.equal(element('#authForm').classList.contains('hidden'), false);
    assert.equal(element('#authSwitch').classList.contains('hidden'), false);
  }
  vm.runInContext('currentAuthStatus = { googleLinked: true, localPasscode: false }', context);
  context.window.showAuthGate(false);
  assert.equal(element('#authForm').classList.contains('hidden'), true, 'known Google-only identity retains its existing flow');
});
