import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

function sidebarHarness({ mobile = false } = {}) {
  const classes = new Set();
  const saved = new Map();
  const attributes = new Map();
  const sidebar = {
    inert: false,
    setAttribute(name, value) { attributes.set(name, value); }
  };
  const toggle = {
    setAttribute(name, value) { attributes.set(`toggle:${name}`, value); }
  };
  const document = {
    body: {
      classList: {
        toggle(name, value) { value ? classes.add(name) : classes.delete(name); },
        contains(name) { return classes.has(name); }
      }
    },
    querySelector(selector) {
      return selector === '#workspaceNavigation' ? sidebar : selector === '#sidebarCollapseToggle' ? toggle : null;
    }
  };
  const window = {
    matchMedia(query) { return { matches: query.includes('max-width') ? mobile : !mobile }; },
    HexiGridPreferences: { setItem(key, value) { saved.set(key, value); } }
  };
  return { classes, saved, attributes, sidebar, toggle, document, window };
}

test('desktop sidebar collapses to an icon rail, keeps labels available, and restores', () => {
  const ui = sidebarHarness();
  const start = app.indexOf('function setSidebarCollapsed(');
  const end = app.indexOf('\nfunction viewFromHash', start);
  assert.ok(start >= 0 && end > start, 'production collapse function remains extractable');
  vm.runInNewContext(`${app.slice(start, end)}\nsetSidebarCollapsed(true);`, ui);
  assert.equal(ui.classes.has('sidebar-collapsed'), true);
  assert.equal(ui.sidebar.inert, false);
  assert.equal(ui.attributes.get('aria-hidden'), 'false');
  assert.equal(ui.attributes.get('toggle:aria-label'), 'Expand navigation');
  assert.equal(ui.saved.get('hexigrid-sidebar-collapsed'), 'on');
  vm.runInNewContext(`${app.slice(start, end)}\nsetSidebarCollapsed(false);`, ui);
  assert.equal(ui.classes.has('sidebar-collapsed'), false);
  assert.equal(ui.sidebar.inert, false);
  assert.equal(ui.attributes.get('toggle:aria-label'), 'Collapse navigation');
  assert.equal(ui.saved.get('hexigrid-sidebar-collapsed'), 'off');
});

test('mobile drawer remains controlled by its existing menu instead of desktop collapse', () => {
  const ui = sidebarHarness({ mobile: true });
  const start = app.indexOf('function setSidebarCollapsed(');
  const end = app.indexOf('\nfunction viewFromHash', start);
  vm.runInNewContext(`${app.slice(start, end)}\nsetSidebarCollapsed(true, { persist: false });`, ui);
  assert.equal(ui.classes.has('sidebar-collapsed'), false);
  assert.equal(ui.sidebar.inert, true);
  assert.equal(ui.saved.has('hexigrid-sidebar-collapsed'), false);
});
