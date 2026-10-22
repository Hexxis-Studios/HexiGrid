import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { isAppUrl, externalUrl, mediaKeys, validIdentity } = require('../desktop/policy.cjs');
const { startEngine, identity } = require('../desktop/engine.cjs');
const { resolveUserDataPath, resolveEngineReuse, applyLoginItemSetting, buildTrayMenu, chooseBackupDirectory } = require('../desktop/main.cjs');
const { linuxAutostartEnabled, setLinuxAutostart } = require('../desktop/autostart.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));

test('desktop native boundary rejects other origins, credentials and executable URLs', () => {
  const origin = 'http://127.0.0.1:4318';
  assert.equal(isAppUrl(origin + '/#memory', origin), true);
  for (const value of ['http://127.0.0.1:4319', 'http://localhost:4318', 'http://127.0.0.1:4318.evil.test', 'http://owner:secret@127.0.0.1:4318', 'file:///tmp/private', 'javascript:alert(1)']) assert.equal(isAppUrl(value, origin), false);
  for (const value of ['file:///tmp/private', 'powershell:command', 'javascript:alert(1)', 'https://owner:secret@example.com']) assert.equal(externalUrl(value), null);
  assert.equal(externalUrl('https://example.com/help'), 'https://example.com/help');
  assert.deepEqual(mediaKeys('media', { mediaTypes: ['audio', 'video'] }), ['microphone', 'camera']);
  assert.deepEqual(mediaKeys('media', { mediaType: 'audio' }), ['microphone']);
  assert.deepEqual(mediaKeys('geolocation'), []);
  assert.deepEqual(mediaKeys('media', { mediaTypes: [] }), []);
  assert.equal(validIdentity({ product: 'hexigrid', port: 4318, pid: 123, instanceId: 'a'.repeat(36), sourceDigest: 'a'.repeat(64) }, 4318), true);
  assert.equal(validIdentity({ product: 'other', port: 4318 }, 4318), false);
});

test('desktop user-data override is absolute and takes precedence over the test environment', () => {
  const environmentPath = path.join(os.tmpdir(), 'hexigrid-test-profile');
  const explicitPath = path.join(os.tmpdir(), 'hexigrid-explicit-profile');
  assert.equal(resolveUserDataPath(undefined, { HEXIGRID_ELECTRON_USER_DATA_DIR: environmentPath }), path.resolve(environmentPath));
  assert.equal(resolveUserDataPath(explicitPath, { HEXIGRID_ELECTRON_USER_DATA_DIR: environmentPath }), path.resolve(explicitPath));
  assert.equal(resolveUserDataPath(undefined, {}), null);
});

test('packaged desktop apps do not attach to an unrelated same-source local workspace', () => {
  assert.equal(resolveEngineReuse({}, true), false);
  assert.equal(resolveEngineReuse({}, false), true);
  assert.equal(resolveEngineReuse({ reuse: false }, false), false);
  assert.equal(resolveEngineReuse({ reuse: true }, true), true);
});

test('desktop sign-in checkbox reverts and reports sync or async OS-setting failures', async () => {
  for (const update of [() => { throw new Error('sync failure'); }, () => Promise.reject(new Error('async failure'))]) {
    const item = { checked: true };
    let errors = 0;
    await applyLoginItemSetting(item, update, () => { errors += 1; });
    assert.equal(item.checked, false);
    assert.equal(errors, 1);
  }
  const item = { checked: true };
  let errors = 0;
  await applyLoginItemSetting(item, () => undefined, () => { errors += 1; });
  assert.equal(item.checked, true);
  assert.equal(errors, 0);
});

test('Windows tray menu dispatches open, agent workspace, startup, help, and quit actions', async () => {
  const actions = [], login = []; let errors = 0;
  const menu = buildTrayMenu({
    Menu: { buildFromTemplate: items => items }, name: 'HexiGrid', platform: 'win32',
    show: () => actions.push('open'),
    agentWorkspace: async () => { actions.push('agent'); },
    loginEnabled: false,
    updateLogin: async enabled => { login.push(enabled); },
    showError: () => { errors += 1; },
    openHelp: () => actions.push('help'),
    quit: () => actions.push('quit')
  });
  const action = label => menu.find(item => item.label === label);
  assert.deepEqual(menu.map(item => item.label), ['Open HexiGrid', 'Agent workspace', undefined, 'Start with Windows', 'Help', undefined, 'Quit HexiGrid']);
  assert.equal(action('Start with Windows').checked, false);
  action('Open HexiGrid').click();
  await action('Agent workspace').click();
  await action('Start with Windows').click({ checked: true });
  action('Help').click();
  action('Quit HexiGrid').click();
  assert.deepEqual(actions, ['open', 'agent', 'help', 'quit']);
  assert.deepEqual(login, [true]);
  assert.equal(errors, 0);
});

test('tray startup action reverts its checkbox when Windows rejects the setting', async () => {
  let errors = 0;
  const menu = buildTrayMenu({
    Menu: { buildFromTemplate: items => items }, name: 'HexiGrid', platform: 'win32',
    show() {}, agentWorkspace: async () => {}, loginEnabled: false,
    updateLogin: async () => { throw new Error('synthetic OS setting failure'); },
    showError: () => { errors += 1; }, openHelp() {}, quit() {}
  });
  const item = { checked: true };
  await menu.find(entry => entry.label === 'Start with Windows').click(item);
  assert.equal(item.checked, false);
  assert.equal(errors, 1);
});

test('native backup-folder picker is restricted to the trusted owner main frame', async () => {
  const origin = 'http://127.0.0.1:4318';
  const frame = { url: `${origin}/#settings` };
  const contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const selected = path.join(os.tmpdir(), 'hexigrid-selected-backups');
  const calls = [];
  const dialog = { async showOpenDialog(parent, options) { calls.push({ parent, options }); return { canceled: false, filePaths: [selected] }; } };
  const result = await chooseBackupDirectory(dialog, { sender: contents, senderFrame: frame }, window, isAppUrl, origin);
  assert.deepEqual(result, { canceled: false, directory: path.resolve(selected) });
  assert.equal(calls[0].parent, window);
  assert.deepEqual(calls[0].options.properties, ['openDirectory']);

  const before = calls.length;
  assert.deepEqual(await chooseBackupDirectory(dialog, undefined, window, isAppUrl, origin), { canceled: true });
  const otherWindow = { webContents: { mainFrame: frame }, isDestroyed: () => false };
  assert.deepEqual(await chooseBackupDirectory(dialog, { sender: otherWindow.webContents, senderFrame: frame }, window, isAppUrl, origin), { canceled: true });
  assert.deepEqual(await chooseBackupDirectory(dialog, { sender: contents, senderFrame: { url: `${origin}/embedded` } }, window, isAppUrl, origin), { canceled: true });
  assert.deepEqual(await chooseBackupDirectory(dialog, { sender: contents, senderFrame: { url: 'https://example.com/' } }, window, isAppUrl, origin), { canceled: true });
  assert.equal(calls.length, before, 'untrusted senders never open a native dialog');

  const cancelDialog = { async showOpenDialog() { return { canceled: true, filePaths: [] }; } };
  assert.deepEqual(await chooseBackupDirectory(cancelDialog, { sender: contents, senderFrame: frame }, window, isAppUrl, origin), { canceled: true });
});

test('desktop preload exposes only the one-shot backup-folder picker and the package includes it', async () => {
  const preload = await fs.readFile(path.join(root, 'desktop/preload.cjs'), 'utf8');
  const main = await fs.readFile(path.join(root, 'desktop/main.cjs'), 'utf8');
  const build = await fs.readFile(path.join(root, 'scripts/build-desktop.mjs'), 'utf8');
  const invoked = []; let exposed;
  vm.runInNewContext(preload, { require(name) {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'hexigridDesktop'); exposed = api; } },
      ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve({ canceled: true }); } }
    };
  } });
  assert.deepEqual(Object.keys(exposed), ['chooseBackupDirectory']);
  assert.deepEqual(await exposed.chooseBackupDirectory(), { canceled: true });
  assert.deepEqual(invoked, [['hexigrid:choose-backup-directory']]);
  assert.match(main, /preload: path\.join\(__dirname, 'preload\.cjs'\)/);
  assert.match(main, /ipcMain\.handle\('hexigrid:choose-backup-directory'/);
  assert.match(build, /for \(const file of \[[^\]]*'main\.cjs', 'preload\.cjs'/);
  assert.match(build, /'main\.cjs', 'preload\.cjs', 'engine\.cjs'/);
});

test('Windows installer registers the toast activator on its packaged Start Menu shortcut', async () => {
  const build = await fs.readFile(path.join(root, 'scripts/build-desktop.mjs'), 'utf8');
  const installer = await fs.readFile(path.join(root, 'scripts/nsis/installer.nsh'), 'utf8');
  const helper = await fs.readFile(path.join(root, 'scripts/Set-HexiGridToastShortcut.ps1'), 'utf8');
  const sourceLauncher = await fs.readFile(path.join(root, 'scripts/Install-HexiGrid-Launcher.ps1'), 'utf8');
  const desktopMain = await fs.readFile(path.join(root, 'desktop/main.cjs'), 'utf8');
  assert.match(build, /notification\/Set-HexiGridToastShortcut\.ps1/);
  assert.match(build, /include: path\.join\(root, 'scripts', 'nsis', 'installer\.nsh'\)/);
  assert.match(installer, /\$newStartMenuLink/);
  assert.match(installer, /-AppUserModelId "Hexxis\.Studios\.HexiGrid"/);
  assert.match(installer, /-ToastActivatorClsid "eb1fdd5b-8f70-4b5a-b230-998a2dc19303"/);
  assert.match(desktopMain, /app\.setToastActivatorCLSID\('eb1fdd5b-8f70-4b5a-b230-998a2dc19303'\)/);
  assert.ok(desktopMain.indexOf("app.setToastActivatorCLSID('eb1fdd5b-8f70-4b5a-b230-998a2dc19303')") < desktopMain.indexOf('await app.whenReady()'));
  assert.match(installer, /Set-HexiGridToastShortcut\.ps1/);
  assert.match(installer, /DetailPrint "Windows call alerts could not be registered; calls remain available in HexiGrid\."/);
  assert.doesNotMatch(installer, /\bAbort\b|\bQuit\b/);
  assert.match(helper, /\[switch\]\$VerifyOnly/);
  assert.match(helper, /\[HexiGridToastShortcut\]::VerifyOnly/);
  assert.match(sourceLauncher, /& \$powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \$toastShortcutSetup/);
  assert.match(sourceLauncher, /\$LASTEXITCODE -ne 0/);
});

test('Linux sign-in preference is a per-user removable autostart entry', async t => {
  const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-autostart-test-'));
  t.after(() => fs.rm(appData, { recursive: true, force: true }));
  const executable = path.join(appData, 'Hexi Grid % Alpha.AppImage');
  assert.equal(await linuxAutostartEnabled(appData), false);
  await setLinuxAutostart({ appData, executable, enabled: true });
  const entry = await fs.readFile(path.join(appData, 'autostart/hexigrid.desktop'), 'utf8');
  assert.match(entry, /Exec=".*Hexi Grid %% Alpha\.AppImage" --background/);
  assert.equal(await linuxAutostartEnabled(appData), true);
  await setLinuxAutostart({ appData, executable, enabled: false });
  assert.equal(await linuxAutostartEnabled(appData), false);
});

test('desktop engine starts with isolated user data and stops only its own child', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-desktop-test-'));
  const engine = await startEngine({ root, node: process.execPath, dataDir, port: 0, reuse: false });
  t.after(async () => { await engine.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const port = Number(new URL(engine.origin).port);
  assert.equal(engine.attached, false);
  assert.equal((await identity(port)).product, 'hexigrid');
  const auth = await (await fetch(`${engine.origin}/api/auth/status`)).json();
  assert.equal(typeof auth, 'object');
  assert.ok((await fs.stat(path.join(dataDir, 'control-room.json'))).isFile());
  await engine.stop();
  assert.equal(await identity(port), null);
});

test('desktop engine chooses another local port when the requested port belongs to another app', { timeout: 35000 }, async t => {
  const unrelated = createServer((_, response) => response.end('unrelated app'));
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  const occupiedPort = unrelated.address().port;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-desktop-port-test-'));
  let engine;
  t.after(async () => {
    await engine?.stop();
    await new Promise(resolve => unrelated.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  engine = await startEngine({ root, node: process.execPath, dataDir, port: occupiedPort, reuse: false });
  const enginePort = Number(new URL(engine.origin).port);
  assert.notEqual(enginePort, occupiedPort);
  assert.equal((await identity(enginePort)).product, 'hexigrid');
  assert.equal(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text(), 'unrelated app');
});

test('Windows owner can move an enabled backup schedule without re-entering its vault passphrase', { skip: process.platform !== 'win32', timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-backup-folder-api-'));
  const engine = await startEngine({ root, node: process.execPath, dataDir, port: 0, reuse: false });
  t.after(async () => { await engine.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const patch = async body => {
    const response = await fetch(`${engine.origin}/api/backup/schedule`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const firstDirectory = path.join(dataDir, 'first-backups');
  const initial = await patch({ enabled: true, directory: firstDirectory, passphrase: 'synthetic isolated backup passphrase', intervalHours: 168, confirmed: true });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.schedule.directory, path.resolve(firstDirectory));
  const nextRunAt = initial.body.schedule.nextRunAt;

  const chosenDirectory = path.join(dataDir, 'owner-chosen-backups');
  const changed = await patch({ enabled: true, directory: chosenDirectory, confirmed: true });
  assert.equal(changed.status, 200, changed.body.error);
  assert.equal(changed.body.schedule.directory, path.resolve(chosenDirectory));
  assert.equal(changed.body.schedule.intervalHours, 168);
  assert.equal(changed.body.schedule.nextRunAt, nextRunAt);

  const rejected = await patch({ enabled: true, directory: 'relative-folder', confirmed: true });
  assert.equal(rejected.status, 400);
  const retry = await patch({ enabled: true, directory: chosenDirectory, confirmed: true });
  assert.equal(retry.status, 200, retry.body.error);
  assert.equal(retry.body.schedule.directory, path.resolve(chosenDirectory));
  assert.equal(retry.body.schedule.nextRunAt, nextRunAt);
  const disabled = await patch({ enabled: false, confirmed: true });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.schedule.enabled, false);
});

test('browser-call preparation uses packaged helper and keeps config in the selected user-data folder', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-desktop-host-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  for (const dir of ['scripts', 'integrations/call-browser/extension', 'integrations/call-browser/native-host']) await fs.mkdir(path.join(fixture, dir), { recursive: true });
  for (const file of ['scripts/prepare-call-browser.mjs', 'integrations/call-browser/extension/manifest.json']) await fs.copyFile(path.join(root, file), path.join(fixture, file));
  const binary = Buffer.from('Synthetic helper; never executed.');
  const hostFile = process.platform === 'win32' ? 'HexiGridCallChatHost.exe' : 'HexiGridCallChatHost';
  await fs.writeFile(path.join(fixture, 'integrations/call-browser/native-host', hostFile), binary);
  const dataDir = path.join(fixture, 'private-workspace');
  const environment = { ...process.env, HEXIGRID_DATA_DIR: dataDir, HEXIGRID_PORT: '55555' };
  execFileSync(process.execPath, [path.join(fixture, 'scripts/prepare-call-browser.mjs')], { env: environment, windowsHide: true, stdio: 'pipe' });
  const config = JSON.parse(await fs.readFile(path.join(dataDir, 'call-browser/host-config.json'), 'utf8'));
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.port, 55555);
  assert.equal(config.node, process.execPath);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'call-browser', hostFile)), binary);
  await fs.writeFile(path.join(dataDir, '.runtime.json'), JSON.stringify({ product: 'hexigrid', port: 55556 }));
  const runtimeEnvironment = { ...process.env, HEXIGRID_DATA_DIR: dataDir };
  delete runtimeEnvironment.HEXIGRID_PORT;
  execFileSync(process.execPath, [path.join(fixture, 'scripts/prepare-call-browser.mjs')], { env: runtimeEnvironment, windowsHide: true, stdio: 'pipe' });
  const runtimeConfig = JSON.parse(await fs.readFile(path.join(dataDir, 'call-browser/host-config.json'), 'utf8'));
  assert.equal(runtimeConfig.port, 55556, 'the desktop host follows its workspace runtime when no port override is supplied');
  if (process.platform === 'linux') {
    const fakeBin = path.join(fixture, 'fake-bin');
    const home = path.join(fixture, 'home');
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, 'google-chrome'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    execFileSync(process.execPath, [path.join(fixture, 'scripts/prepare-call-browser.mjs'), '--register'], {
      env: { ...environment, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` }, windowsHide: true, stdio: 'pipe' });
    const registration = path.join(home, '.config/google-chrome/NativeMessagingHosts/com.hexigrid.call_chat.json');
    const registeredHost = JSON.parse(await fs.readFile(registration, 'utf8'));
    assert.equal(registeredHost.name, 'com.hexigrid.call_chat');
    assert.equal(registeredHost.path, path.join(dataDir, 'call-browser', hostFile));
  }
  await assert.rejects(fs.stat(path.join(fixture, 'data')));
});
