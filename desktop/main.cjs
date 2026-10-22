const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, session, shell, desktopCapturer } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startEngine } = require('./engine.cjs');
const { isAppUrl, externalUrl, mediaKeys } = require('./policy.cjs');
const { linuxAutostartEnabled, setLinuxAutostart } = require('./autostart.cjs');

function resolveUserDataPath(explicit, environment = process.env) {
  const requested = explicit || environment.HEXIGRID_ELECTRON_USER_DATA_DIR;
  return requested ? path.resolve(requested) : null;
}

function resolveEngineReuse(options = {}, packaged = app.isPackaged) {
  return options.reuse === true || (options.reuse !== false && !packaged);
}

function applyLoginItemSetting(item, update, showError) {
  const requested = item.checked;
  const fail = () => { item.checked = !requested; showError(); };
  try { return Promise.resolve(update()).catch(fail); }
  catch { fail(); return Promise.resolve(); }
}

function buildTrayMenu({ Menu, name, platform, show, agentWorkspace, loginEnabled, updateLogin, showError, openHelp, quit }) {
  return Menu.buildFromTemplate([
    { label: `Open ${name}`, click: show },
    { label: 'Agent workspace', click: () => Promise.resolve(agentWorkspace()).catch(() => {}) },
    { type: 'separator' },
    { label: platform === 'win32' ? 'Start with Windows' : 'Start at login', type: 'checkbox', checked: loginEnabled,
      click: item => applyLoginItemSetting(item, () => updateLogin(item.checked), showError) },
    { label: 'Help', click: openHelp },
    { type: 'separator' },
    { label: `Quit ${name}`, click: quit }
  ]);
}

async function chooseBackupDirectory(dialog, event, window, isAppUrl, origin) {
  const frame = event?.senderFrame;
  if (!event || !window || window.isDestroyed() || event.sender !== window.webContents
    || frame !== window.webContents.mainFrame || !isAppUrl(frame.url, origin)) return { canceled: true };
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose encrypted backup folder',
    properties: ['openDirectory']
  });
  const directory = result?.filePaths?.[0];
  return result?.canceled || typeof directory !== 'string' || !directory
    ? { canceled: true }
    : { canceled: false, directory: path.resolve(directory) };
}

async function startDesktop(options = {}) {
  const root = options.root || (app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(__dirname, '..'));
  const { BRAND } = await import(pathToFileURL(path.join(root, 'lib/brand.mjs')).href);
  app.setName(BRAND.name);
  if (process.platform === 'win32') {
    app.setAppUserModelId('Hexxis.Studios.HexiGrid');
    app.setToastActivatorCLSID('eb1fdd5b-8f70-4b5a-b230-998a2dc19303');
  }
  const userDataPath = resolveUserDataPath(options.userData);
  if (userDataPath) app.setPath('userData', userDataPath);
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  await app.whenReady();
  let quitting = false; let stopped = false; let window; let tray;
  const windows = new Set();
  const engine = await startEngine({ root,
    node: options.node || (app.isPackaged
      ? path.join(process.resourcesPath, 'runtime', ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']))
      : require('node:child_process').execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'node.exe' : 'node'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]),
    dataDir: path.join(app.getPath('userData'), 'workspace'), port: options.port ?? 4318,
    reuse: resolveEngineReuse(options), onFailure: message => { if (!quitting) dialog.showErrorBox(BRAND.name, message); }
  });
  const partition = `persist:hexigrid`;
  const ses = session.fromPartition(partition);
  const permissionFile = path.join(app.getPath('userData'), 'device-permissions.json');
  let grants = {};
  try { grants = JSON.parse(await fs.readFile(permissionFile, 'utf8')); } catch { /* first launch */ }
  const trusted = (contents, url) => [...windows].some(item => !item.isDestroyed() && item.webContents === contents)
    && isAppUrl(url || contents?.getURL(), engine.origin);
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission === 'clipboard-sanitized-write') return trusted(contents, origin);
    const keys = mediaKeys(permission, details);
    return trusted(contents, origin) && keys.length > 0 && keys.every(key => grants[key] === true);
  });
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const keys = mediaKeys(permission, details);
    if (!trusted(contents, details.requestingUrl)) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (!keys.length) return callback(false);
    if (keys.every(key => grants[key] === true)) return callback(true);
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: BRAND.name,
      message: `Allow ${BRAND.name} to use ${keys.join(' and ')}?`,
      detail: 'Your agent can use these devices only within the access you grant in HexiGrid. Manage agent access in HexiGrid’s Permissions.',
      buttons: ['Allow', 'Not now'], defaultId: 0, cancelId: 1 });
    if (response !== 0) return callback(false);
    if (!trusted(contents, details.requestingUrl)) return callback(false);
    for (const key of keys) grants[key] = true;
    try { await fs.writeFile(permissionFile, JSON.stringify(grants)); } catch { /* session-only consent */ }
    callback(true);
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const owner = [...windows].find(item => !item.isDestroyed() && request.frame === item.webContents.mainFrame);
    if (!owner || !isAppUrl(request.frame.url, engine.origin)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (!sources.length) return callback({});
      const { response } = await dialog.showMessageBox(owner, { title: 'Share your screen',
        message: 'Choose what to share with your agent.', buttons: [...sources.map(source => source.name), 'Cancel'], cancelId: sources.length });
      if (response >= sources.length) return callback({});
      callback({ video: sources[response] });
    } catch { callback({}); }
  }, { useSystemPicker: true });
  window = new BrowserWindow({ title: BRAND.name, width: 1320, height: 900, minWidth: 780, minHeight: 560,
    show: !process.argv.includes('--background'), icon: path.join(root, 'public/icon-512.png'),
    webPreferences: { partition, preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  window.setMenuBarVisibility(false);
  const show = () => { window.show(); if (window.isMinimized()) window.restore(); window.focus(); };
  const agentWorkspace = async () => {
    const child = new BrowserWindow({ title: `${BRAND.name} · Agent workspace`, width: 1160, height: 850,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    protectNavigation(child);
    await child.loadURL(`${engine.origin}/agent-interface.html`);
  };
  function protectNavigation(target) {
    windows.add(target);
    target.once('closed', () => windows.delete(target));
    target.webContents.on('will-navigate', (event, url) => {
      if (isAppUrl(url, engine.origin)) return;
      event.preventDefault();
      const safe = externalUrl(url); if (safe) void shell.openExternal(safe);
    });
    target.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (new URL(url).origin === 'https://hexigrid.firebaseapp.com') return { action: 'allow', overrideBrowserWindowOptions: {
          autoHideMenuBar: true, webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true } } };
      } catch { /* malformed popup URL */ }
      if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: {
        autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
      const safe = externalUrl(url); if (safe) void shell.openExternal(safe);
      return { action: 'deny' };
    });
  }
  protectNavigation(window);
  ipcMain.handle('hexigrid:choose-backup-directory', event => chooseBackupDirectory(dialog, event, window, isAppUrl, engine.origin));
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  app.on('second-instance', show);
  app.on('activate', show);
  const loginAppData = app.getPath('appData');
  const loginExecutable = process.env.APPIMAGE || process.execPath;
  const loginEnabled = process.platform === 'linux'
    ? await linuxAutostartEnabled(loginAppData)
    : app.getLoginItemSettings({ path: process.execPath, args: process.platform === 'win32' ? ['--background'] : [] }).openAtLogin;
  const menu = buildTrayMenu({
    Menu, name: BRAND.name, platform: process.platform, show,
    agentWorkspace,
    loginEnabled,
    updateLogin: enabled => process.platform === 'linux'
      ? setLinuxAutostart({ appData: loginAppData, executable: loginExecutable, enabled })
      : app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === 'win32' ? { path: process.execPath, args: ['--background'] } : {}) }),
    showError: () => dialog.showErrorBox(BRAND.name, 'HexiGrid could not update its sign-in setting.'),
    openHelp: () => { show(); void window.loadURL(`${engine.origin}/#guide`); },
    quit: () => app.quit()
  });
  tray = new Tray(path.join(root, 'public/icon-192.png'));
  tray.setToolTip(`${BRAND.name} · ${engine.attached ? 'Existing workspace' : 'Local workspace'}`);
  tray.on('click', show);
  tray.on('double-click', show);
  tray.setContextMenu(menu);
  app.on('before-quit', event => {
    quitting = true;
    if (stopped) return;
    event.preventDefault(); stopped = true;
    engine.stop().finally(() => app.quit());
  });
  await window.loadURL(`${engine.origin}/`);
  return { window, engine, tray, session: ses, root };
}

module.exports = { startDesktop, resolveUserDataPath, resolveEngineReuse, applyLoginItemSetting, buildTrayMenu, chooseBackupDirectory };
if (require.main === module) startDesktop().catch(() => {
  dialog.showErrorBox('HexiGrid', 'HexiGrid could not open its local workspace. Your existing data and other applications were not changed. Close only HexiGrid and try again.');
  app.quit();
});
