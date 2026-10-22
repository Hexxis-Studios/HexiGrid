import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/backup-ui.js', import.meta.url), 'utf8');
function render(available, browser = false, picker = false, scheduleEnabled = false) {
  const root = { innerHTML: '', insertAdjacentHTML(position, value) { this.innerHTML += value; } };
  const ctx = vm.createContext({ document: { querySelector: () => root }, state: { data: { settings: { backupSchedule: { enabled: scheduleEnabled, intervalHours: 24, directory: 'synthetic-folder' } }, backupRecovery: { localRollbackAvailable: available } } }, isStandaloneBrowser: () => browser, escapeHtml: value => String(value),
    window: picker ? { hexigridDesktop: { chooseBackupDirectory() {} } } : {} });
  vm.runInContext(source.slice(0, source.indexOf('async function makeBackup')), ctx);
  ctx.renderSecurity();
  return root.innerHTML;
}
test('restore recovery control is disabled without an authoritative recovery point', () => {
  assert.match(render(false), /data-control-action="backup-rollback" disabled/);
  assert.match(render(false), /No restore recovery point is available/);
  assert.match(render(false), /Imported automation stays paused/);
});
test('desktop and browser recoveries expose only their currently available point', () => {
  for (const browser of [false, true]) {
    const html = render(true, browser);
    assert.match(html, /A recovery point is available/);
    assert.doesNotMatch(html, /data-control-action="backup-rollback" disabled/);
  }
  assert.match(render(true, true), /browser vault uses its own backup format/);
});

test('prepared backups retain a clickable download until replaced and never claim a saved file', async () => {
  const revoked = [], links = [], notices = [];
  let existing;
  const ctx = vm.createContext({
    document: {
      querySelector(selector) { return selector === '#securityTools .provider-actions' ? { append(link) { links.push(link); existing = link; } } : existing; },
      createElement() { return { dataset: {}, remove() { existing = undefined; } }; }
    },
    window: { hexigridModal: async () => ['disposable fixture passphrase'] },
    api: async () => ({ envelope: { data: 'encrypted fixture' }, filename: 'backup.json' }),
    Blob, URL: { createObjectURL: () => `blob:fixture-${links.length}`, revokeObjectURL: value => revoked.push(value) },
    notify: value => notices.push(value)
  });
  vm.runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), ctx);
  await ctx.makeBackup();
  assert.equal(links[0].download, 'backup.json');
  assert.equal(links[0].textContent, 'Save encrypted backup');
  assert.deepEqual(revoked, []);
  assert.match(notices[0], /ready/);
  assert.doesNotMatch(notices[0], /downloaded/);
  await ctx.makeBackup();
  assert.deepEqual(revoked, ['blob:fixture-0']);
});

test('snapshot failure status is escaped, actionable, and includes retry without claiming completion', () => {
  const root = { innerHTML: '', insertAdjacentHTML(position, value) { this.innerHTML += value; } };
  const ctx = vm.createContext({ document: { querySelector: () => root }, state: { data: { settings: { backupSchedule: { enabled: true, intervalHours: 24, directory: 'synthetic', lastError: '<script>broken</script>' } } } }, isStandaloneBrowser: () => false, escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
  vm.runInContext(source.slice(0, source.indexOf('async function makeBackup')), ctx); ctx.renderSecurity();
  assert.match(root.innerHTML, /Snapshot needs attention/); assert.match(root.innerHTML, /Retry snapshot now/);
  assert.match(root.innerHTML, /&lt;script&gt;/); assert.doesNotMatch(root.innerHTML, /<script>/);
});

test('scheduled snapshot shows a folder chooser only when the native desktop bridge exists', () => {
  assert.match(render(false, false, true, true), /data-control-action="backup-directory">Change folder/);
  assert.doesNotMatch(render(false, false, false), /data-control-action="backup-directory"/);
  assert.doesNotMatch(render(false, true, true), /data-control-action="backup-directory"/);
});

test('manual snapshot failure is shown, button released, and persisted status refreshed', async () => {
  const listeners = [], notices = []; let refreshed = 0;
  const button = { dataset: { controlAction: 'backup-snapshot' }, disabled: false, textContent: '' };
  const ctx = vm.createContext({ document: { addEventListener(type, handler) { listeners.push(handler); } }, window: {}, state: { data: { settings: {} } },
    async approvedRequest() { throw Error('Synthetic disk failure'); }, notify(message, error) { notices.push({ message, error }); }, async refresh() { refreshed++; } });
  vm.runInContext(source, ctx);
  await listeners[0]({ target: { closest() { return button; } } });
  assert.deepEqual(notices, [{ message: 'Synthetic disk failure', error: true }]); assert.equal(button.disabled, false); assert.equal(refreshed, 1);
});

async function scheduleClick({ enabled = false, cancel = false, fail = false } = {}) {
  const listeners = [], notices = [], writes = []; let refreshed = 0;
  const button = { dataset: { controlAction: 'backup-schedule' }, disabled: false };
  const ctx = vm.createContext({ document: { addEventListener(type, handler) { listeners.push(handler); } },
    window: { hexigridModal: async () => cancel ? null : enabled ? true : ['public synthetic backup only', '168 — Weekly'] },
    state: { data: { settings: { backupSchedule: { enabled } } } },
    async approvedRequest(url, options) { writes.push(JSON.parse(options.body)); if (fail) throw Error('Synthetic vault unavailable'); },
    notify(message, error) { notices.push({ message, error }); }, async refresh() { refreshed++; }
  });
  vm.runInContext(source, ctx); await listeners[0]({ target: { closest() { return button; } } });
  return { button, notices, writes, refreshed };
}
for (const enabled of [false, true]) {
  test(`snapshot ${enabled ? 'disable' : 'enable'} failure releases control and reports error`, async () => {
    const result = await scheduleClick({ enabled, fail: true });
    assert.deepEqual(result.notices, [{ message: 'Synthetic vault unavailable', error: true }]);
    assert.equal(result.button.disabled, false); assert.equal(result.refreshed, 0);
  });
  test(`cancelled snapshot ${enabled ? 'disable' : 'enable'} does not save`, async () => {
    const result = await scheduleClick({ enabled, cancel: true });
    assert.equal(result.writes.length, 0); assert.equal(result.notices.length, 0); assert.equal(result.button.disabled, false);
  });
}
test('weekly snapshot setup preserves selected interval and reports only successful save', async () => {
  const result = await scheduleClick();
  assert.equal(result.writes[0].intervalHours, 168); assert.equal(result.writes[0].confirmed, true);
  assert.equal(result.refreshed, 1); assert.equal(result.button.disabled, false);
  assert.deepEqual(result.notices, [{ message: 'Automatic snapshot settings updated.', error: undefined }]);
});

test('changing the backup folder saves the owner-selected path without resetting its passphrase', async () => {
  const listeners = [], notices = [], writes = []; let refreshed = 0;
  const button = { dataset: { controlAction: 'backup-directory' }, disabled: false };
  const ctx = vm.createContext({ document: { addEventListener(type, handler) { listeners.push(handler); } },
    window: { hexigridDesktop: { chooseBackupDirectory: async () => ({ canceled: false, directory: 'C:\\QA\\Encrypted Backups' }) } },
    state: { data: { settings: { backupSchedule: { enabled: true, intervalHours: 168 } } } },
    async approvedRequest(url, options, message) { writes.push({ url, body: JSON.parse(options.body), message }); },
    notify(message, error) { notices.push({ message, error }); }, async refresh() { refreshed++; }
  });
  vm.runInContext(source, ctx);
  await listeners[0]({ target: { closest() { return button; } } });
  assert.equal(writes[0].url, '/api/backup/schedule');
  assert.deepEqual(writes[0].body, { enabled: true, directory: 'C:\\QA\\Encrypted Backups', confirmed: true });
  assert.match(writes[0].message, /C:\\QA\\Encrypted Backups/);
  assert.deepEqual(notices, [{ message: 'Backup folder updated.', error: undefined }]);
  assert.equal(refreshed, 1);
  assert.equal(button.disabled, false);
});

test('cancelled folder picker leaves the schedule unchanged', async () => {
  const listeners = [], writes = [];
  const button = { dataset: { controlAction: 'backup-directory' }, disabled: false };
  const ctx = vm.createContext({ document: { addEventListener(type, handler) { listeners.push(handler); } },
    window: { hexigridDesktop: { chooseBackupDirectory: async () => ({ canceled: true }) } },
    state: { data: { settings: { backupSchedule: { enabled: true, intervalHours: 24 } } } },
    async approvedRequest(url, options) { writes.push(options); }, notify() {}, async refresh() {}
  });
  vm.runInContext(source, ctx);
  await listeners[0]({ target: { closest() { return button; } } });
  assert.equal(writes.length, 0);
  assert.equal(button.disabled, false);
});

test('malformed restore files show a plain-language error before asking for a passphrase', async () => {
  const listeners = [], notices = [];
  const input = { value: 'previous.json', files: [{ text: async () => '{not json' }], click() {} };
  const button = { dataset: { controlAction: 'import-backup' } };
  let passphrasePrompted = false;
  const ctx = vm.createContext({
    document: { querySelector: () => input, addEventListener(type, handler) { listeners.push(handler); } },
    notify(message, error) { notices.push({ message, error }); },
    async modalRequest() { passphrasePrompted = true; return ['synthetic passphrase']; },
    async approvedRequest() { throw new Error('must not restore malformed data'); },
    async refresh() {}
  });
  vm.runInContext(source, ctx);
  await listeners[1]({ target: { closest: selector => selector === '[data-control-action="import-backup"]' ? button : null }, stopImmediatePropagation() {} });
  assert.equal(input.value, '');
  await input.onchange();
  assert.deepEqual(notices, [{ message: 'This file is not a valid encrypted HexiGrid backup.', error: true }]);
  assert.equal(passphrasePrompted, false);
});
