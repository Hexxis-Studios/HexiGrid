import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('human sidebar has seven primary destinations and groups secondary pages under Settings', async () => {
  const [navigation, html] = await Promise.all([read('public/control-shell.js'), read('public/index.html')]);
  const primary = navigation.match(/const primary = (\[[\s\S]*?\n  \]);/)?.[1];
  assert.ok(primary, 'primary navigation definition exists');
  const items = [...primary.matchAll(/\{ view: '([^']+)', label: '([^']+)', icon: '([^']+)' \}/g)]
    .map(([, view, label, icon]) => ({ view, label, icon }));
  assert.deepEqual(items.map(({ label }) => label), ['Home', 'Agents', 'Chat', 'Calls', 'Memory', 'Workspace', 'Settings']);
  assert.equal(new Set(items.map(({ view }) => view)).size, 7, 'primary route targets are unique');
  const navMarkup = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(navMarkup, 'primary sidebar exists in the human interface');
  assert.equal([...navMarkup.matchAll(/class="nav-item(?: active)?" data-view=/g)].length, 7, 'initial sidebar markup also has exactly seven destinations');
  assert.match(navigation, /label: 'Connections'/);
  assert.match(navigation, /label: 'AI providers'/);
  assert.match(navigation, /label: 'Tools & integrations'/);
  assert.match(navigation, /label: 'Help'[\s\S]*label: 'How agents talk'/);
  assert.match(navigation, /label: 'AI usage'/);
  assert.match(navigation, /querySelector\('#view-settings \.settings-grid'\)\.before\(settingsSubmenu\)/);
  assert.doesNotMatch(navigation, /nav\.append\(button, settingsSubmenu\)/, 'secondary pages must not lengthen the primary sidebar');
  assert.match(html, /src="\/control-shell\.js" defer/);
});

test('every secondary navigation target maps to a source page and retains the existing hash router', async () => {
  const [navigation, html, providers, integrations, shell, liveCall, app] = await Promise.all([
    read('public/control-shell.js'), read('public/index.html'), read('public/providers.js'),
    read('public/integrations.js'), read('public/control-shell.js'), read('public/live-call.js'), read('public/app.js')
  ]);
  const views = [...navigation.matchAll(/\{ view: '([a-z-]+)', label:/g)].map((match) => match[1]);
  assert.equal(new Set(views).size, views.length, 'each route appears once in the consolidated navigation');
  const pageIds = new Set([
    ...[...html.matchAll(/id="view-([a-z-]+)"/g)].map((match) => match[1]),
    ...[providers, integrations, shell, liveCall].flatMap((source) => [...source.matchAll(/id\s*=\s*['"]view-([a-z-]+)['"]/g)].map((match) => match[1]))
  ]);
  for (const view of views) assert.ok(pageIds.has(view), `navigation destination #${view} has a page root`);
  assert.doesNotMatch(liveCall, /dataset\.view\s*=\s*'live'/, 'the live page cannot inject a second sidebar entry');
  const start = app.indexOf('function viewFromHash(');
  const end = app.indexOf('\nfunction showView(', start);
  const context = vm.createContext({ document: { getElementById: (id) => pageIds.has(id.replace(/^view-/, '')) ? {} : null } });
  vm.runInContext(app.slice(start, end), context);
  for (const view of views) assert.equal(context.viewFromHash(`#${view}`), view, `hash #${view} still opens its page`);
  assert.match(app, /function viewFromHash\(hash\)/);
  assert.match(app, /document\.getElementById\(`view-\$\{candidate\}`\)/);
  assert.match(app, /history\.pushState\(null, '', `#\$\{view\}`\)/);
  assert.match(app, /HexiGridNavigation\?\.activate\(view\)/);
});

test('page headings are functional names and the navigation has a collapse control', async () => {
  const [html, app, shell, guide] = await Promise.all([
    read('public/index.html'), read('public/app.js'), read('public/control-shell.js'), read('public/guide-ui.js')
  ]);
  assert.match(html, /id="sidebarCollapseToggle"[^>]*data-action="toggle-sidebar-collapse"/);
  assert.doesNotMatch(html, /Everyone, in one place|Bring every AI agent into one place|Your control room is ready|Recall what matters|Make HexiGrid yours/);
  assert.doesNotMatch(app, /viewEyebrow|Shape every identity|Recall and learn|Think together|Call your agents|Create and test locally|Connect what you use|Make HexiGrid yours|AI ready|Models available/);
  assert.doesNotMatch(shell, /Extend the control room/);
  assert.doesNotMatch(guide, /Your control room is taking shape/);
  assert.match(app, /overview: 'Home'.*agents: 'Agents'.*memory: 'Memory'/s);
});

test('Settings pages keep the sidebar stable and expose the page navigation in Settings', async () => {
  const source = await read('public/control-shell.js');
  const start = source.indexOf('    function activate(view) {');
  const end = source.indexOf("    nav.dataset.simpleNavigation", start);
  assert.ok(start >= 0 && end > start);
  const attributes = new Map();
  const buttons = ['settings', 'providers', 'room'].map(view => ({
    dataset: { view },
    classList: { toggle(name, active) { attributes.set(`${view}:${name}`, active); } },
    setAttribute(name, value) { attributes.set(`${view}:${name}`, value); },
    removeAttribute(name) { attributes.delete(`${view}:${name}`); }
  }));
  const settingsSubmenu = { hidden: true };
  const bodyClasses = new Map();
  const context = vm.createContext({
    settingsSubmenu, settingsViews: new Set(['settings', 'providers']),
    document: { body: { classList: { toggle(name, value) { bodyClasses.set(name, value); } } } },
    setSidebarCollapsed() { assert.fail('a page change must not alter the owner’s collapsed navigation preference'); },
    nav: { querySelectorAll: () => buttons, querySelector: () => buttons[0] }
  });
  vm.runInContext(`${source.slice(start, end)}\nactivate('providers');`, context);
  assert.equal(settingsSubmenu.hidden, true);
  assert.equal(bodyClasses.get('settings-detail'), true);
  assert.equal(attributes.get('providers:aria-current'), 'page');
  assert.equal(attributes.get('settings:active'), true);
  vm.runInContext("activate('settings');", context);
  assert.equal(settingsSubmenu.hidden, false);
  assert.equal(bodyClasses.get('settings-detail'), false);
  vm.runInContext("activate('room');", context);
  assert.equal(settingsSubmenu.hidden, true);
  assert.equal(attributes.get('room:aria-current'), 'page');
  assert.equal(attributes.has('providers:aria-current'), false);
});
