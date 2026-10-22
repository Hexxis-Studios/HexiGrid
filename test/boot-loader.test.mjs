import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const geometry = await fs.readFile(new URL('../public/boot-geometry.js', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../public/boot-loader.js', import.meta.url), 'utf8');

function boot({ reduced = false } = {}) {
  let now = 100, nextId = 0, removed = false, destroyed = 0;
  const timers = new Map(), listeners = new Map(), classes = new Set(['booting']);
  const classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) };
  const loader = { classList, setAttribute() {}, addEventListener: (name, fn) => listeners.set(name, fn), remove() { removed = true; } };
  const drawing = new Proxy({}, { get: (_, name) => name.startsWith('create') ? () => ({ addColorStop() {} }) : () => {} });
  const canvas = { getContext: () => drawing, getBoundingClientRect: () => ({ width: 400, height: 400 }) };
  const window = { HexiGridBootEnvironment: { destroy() { destroyed++; } } };
  const context = vm.createContext({ window, document: { hidden: true, documentElement: { classList }, body: { classList }, querySelector: name => name === '#bootLoader' ? loader : canvas, addEventListener() {}, removeEventListener() {} },
    matchMedia: query => ({ matches: reduced && query.includes('reduced-motion') }), performance: { now: () => now }, devicePixelRatio: 1,
    addEventListener() {}, requestAnimationFrame: () => ++nextId, cancelAnimationFrame() {},
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(geometry, context);
  vm.runInContext(source, context);
  function advance(ms) {
    const until = now + ms;
    while (true) {
      const due = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = until;
  }
  return { advance, enter: () => listeners.get('click')(), complete: () => window.hexigridBoot.complete(), classes, removed: () => removed, destroyed: () => destroyed };
}

test('background opening completes without any animation frames and cleans up once', () => {
  const page = boot(); page.complete(); page.advance(1500); page.enter();
  assert.equal(page.classes.has('booting'), true);
  page.advance(5000);
  assert.equal(page.classes.has('booting'), false);
  assert.equal(page.removed(), true);
  assert.equal(page.destroyed(), 1);
  page.enter(); page.complete(); page.advance(10000);
  assert.equal(page.destroyed(), 1);
});

test('readiness timers never enter the app without the user gesture', () => {
  const page = boot(); page.advance(20000);
  assert.equal(page.classes.has('ready'), true);
  assert.equal(page.classes.has('booting'), true);
  assert.equal(page.removed(), false);
});

test('reduced-motion opening also completes without animation frames', () => {
  const page = boot({ reduced: true }); page.complete(); page.enter(); page.advance(500);
  assert.equal(page.classes.has('booting'), false);
  assert.equal(page.removed(), true);
});
