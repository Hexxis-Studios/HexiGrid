import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const mainSource = await fs.readFile(path.join(root, 'desktop/main.cjs'), 'utf8');

function makeDesktopHarness({ pickerResult = { canceled: false, filePaths: ['C:/HexiGrid Backups'] }, pickerError } = {}) {
  const calls = { engineStops: 0, quits: 0, picker: 0, tray: null, window: null, ipc: new Map() };
  let finishStop;
  const stopGate = new Promise(resolve => { finishStop = resolve; });
  const engine = {
    origin: 'http://127.0.0.1:4318',
    attached: false,
    stop() { calls.engineStops += 1; return stopGate; }
  };

  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    setName() {},
    setAppUserModelId() {},
    setToastActivatorCLSID() {},
    setPath() {},
    getPath(name) { return name === 'appData' ? 'C:/Users/QA/AppData/Roaming' : 'C:/Users/QA/AppData/Local/HexiGrid'; },
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: async () => {},
    quit() {
      calls.quits += 1;
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      app.emit('before-quit', event);
      return event;
    }
  });

  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.minimized = false;
      this.destroyed = false;
      this.actions = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.setWindowOpenHandler = handler => { this.webContents.openHandler = handler; };
      calls.window = this;
    }
    setMenuBarVisibility(value) { this.actions.push(['menu-bar', value]); }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.actions.push(['restore']); }
    show() { this.actions.push(['show']); }
    hide() { this.actions.push(['hide']); }
    focus() { this.actions.push(['focus']); }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.webContents.mainFrame.url = url; this.actions.push(['load', url]); }
  }

  class FakeTray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; calls.tray = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
  }

  const mediaSession = {
    setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
    setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
    setDisplayMediaRequestHandler(handler, options) { this.displayMediaRequest = handler; this.displayMediaOptions = options; }
  };
  const electron = {
    app,
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: template => template },
    Tray: FakeTray,
    dialog: {
      async showOpenDialog() {
        calls.picker += 1;
        if (pickerError) throw pickerError;
        return pickerResult;
      },
      async showMessageBox() { return { response: 1 }; },
      showErrorBox() {}
    },
    ipcMain: { handle(channel, handler) { calls.ipc.set(channel, handler); } },
    session: { fromPartition: () => mediaSession },
    shell: { openExternal() {} },
    desktopCapturer: { getSources: async () => [] }
  };
  const dependencies = {
    electron,
    './engine.cjs': { startEngine: async () => engine },
    './policy.cjs': require('../desktop/policy.cjs'),
    './autostart.cjs': require('../desktop/autostart.cjs')
  };
  const mockedRequire = id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id);
  const filename = path.join(root, 'desktop/main.cjs');
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module.require = mockedRequire;
  const simulatedProcess = {
    platform: 'win32', argv: [], execPath: process.execPath, env: {}
  };
  module._compile(`const process = ${JSON.stringify(simulatedProcess)};\n${mainSource}`, filename);

  return { calls, app, engine, finishStop, mediaSession, desktop: module.exports };
}

test('desktop startup wires tray restore, close-to-tray, owned-engine quit, and trusted backup picker IPC', async () => {
  const harness = makeDesktopHarness();
  const { calls, app, engine, finishStop, desktop } = harness;
  const started = await desktop.startDesktop({ root, node: process.execPath, port: 4318 });
  assert.equal(started.engine, engine);
  assert.equal(calls.window.options.show, true);
  assert.equal(calls.window.webContents.mainFrame.url, `${engine.origin}/`);
  assert.ok(calls.tray, 'startDesktop constructs the native tray');
  assert.equal(calls.tray.tooltip, 'HexiGrid · Local workspace');

  calls.window.actions.length = 0;
  calls.window.minimized = true;
  calls.tray.emit('click');
  assert.deepEqual(calls.window.actions, [['show'], ['restore'], ['focus']]);
  calls.window.actions.length = 0;
  calls.tray.emit('double-click');
  assert.deepEqual(calls.window.actions, [['show'], ['focus']]);

  const closeEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  calls.window.emit('close', closeEvent);
  assert.equal(closeEvent.prevented, true);
  assert.deepEqual(calls.window.actions.at(-1), ['hide']);
  assert.equal(calls.engineStops, 0, 'closing the window keeps the engine running in the tray');

  const chooseDirectory = calls.ipc.get('hexigrid:choose-backup-directory');
  assert.equal(typeof chooseDirectory, 'function', 'the native folder picker is registered through IPC');
  const frame = calls.window.webContents.mainFrame;
  const trustedEvent = { sender: calls.window.webContents, senderFrame: frame };
  const selected = await chooseDirectory(trustedEvent);
  assert.equal(selected.canceled, false);
  assert.equal(selected.directory, path.resolve('C:/HexiGrid Backups'));
  assert.equal(calls.picker, 1);

  const canceled = makeDesktopHarness({ pickerResult: { canceled: true, filePaths: [] } });
  const canceledStart = await canceled.desktop.startDesktop({ root, node: process.execPath, port: 4319 });
  const canceledChooser = canceled.calls.ipc.get('hexigrid:choose-backup-directory');
  const canceledEvent = { sender: canceled.calls.window.webContents, senderFrame: canceled.calls.window.webContents.mainFrame };
  assert.equal((await canceledChooser(canceledEvent)).canceled, true);
  assert.equal(canceled.calls.picker, 1);
  canceled.finishStop();
  await canceledStart.engine.stop();

  const pickerFailure = new Error('synthetic native picker failure');
  const failed = makeDesktopHarness({ pickerError: pickerFailure });
  const failedStart = await failed.desktop.startDesktop({ root, node: process.execPath, port: 4320 });
  const failedChooser = failed.calls.ipc.get('hexigrid:choose-backup-directory');
  const failedEvent = { sender: failed.calls.window.webContents, senderFrame: failed.calls.window.webContents.mainFrame };
  await assert.rejects(failedChooser(failedEvent), /synthetic native picker failure/);
  assert.equal(failed.calls.picker, 1);
  failed.finishStop();
  await failedStart.engine.stop();

  const unauthorizedDialogCalls = calls.picker;
  const untrustedEvent = { sender: {}, senderFrame: frame };
  assert.equal((await chooseDirectory(untrustedEvent)).canceled, true);
  assert.equal(calls.picker, unauthorizedDialogCalls, 'untrusted IPC cannot open the native folder picker');

  const quitItem = calls.tray.menu.find(item => item.label === 'Quit HexiGrid');
  quitItem.click();
  assert.equal(calls.engineStops, 1, 'Quit stops the engine instance returned to this desktop shell');
  assert.equal(calls.quits, 1, 'the first quit waits for the owned engine to stop');
  finishStop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.engineStops, 1, 'the recursive final quit does not stop the engine twice');
  assert.equal(calls.quits, 2, 'the app resumes quitting after engine shutdown');
});
