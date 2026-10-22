import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFile(path.join(root, file), 'utf8');

test('Start Menu installer validates its launcher before requesting Windows registration', async () => {
  const source = await read('scripts/Install-HexiGrid-Launcher.ps1');
  assert.match(source, /Test-Path -LiteralPath \$launcher -PathType Leaf/);
  assert.ok(source.indexOf('Test-Path -LiteralPath $launcher') < source.indexOf('Get-Command powershell.exe'));
  assert.match(source, /CreateShortcut\(\$shortcutPath\)/);
  assert.match(source, /\$shortcut\.Save\(\)/);
  // Registration requires WScript.Shell on Windows; this harness never instantiates COM.
});

test('autostart installer declares a logon task and validates the watchdog before task cmdlets', async () => {
  const source = await read('scripts/Install-HexiGrid-Autostart.ps1');
  assert.match(source, /Test-Path -LiteralPath \$watchdog -PathType Leaf/);
  assert.ok(source.indexOf('Test-Path -LiteralPath $watchdog') < source.indexOf('New-ScheduledTaskAction'));
  assert.match(source, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(source, /Register-ScheduledTask[\s\S]*-Force/);
  assert.match(source, /Start-ScheduledTask/);
  // OS task registration and reboot/sign-in behavior are intentionally not invoked.
});

test('Windows uninstall removes only its own sign-in entry and preserves it during upgrades', async () => {
  const source = await read('scripts/nsis/installer.nsh');
  const cleanup = source.match(/!macro customUnInstall[\s\S]*?!macroend/);
  assert.ok(cleanup, 'the NSIS uninstaller must define the startup cleanup hook');
  assert.match(cleanup[0], /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(cleanup[0], /ReadRegStr \$0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{APP_ID\}"/);
  assert.match(cleanup[0], /\$\{APP_EXECUTABLE_FILENAME\}.*--background/);
  assert.match(cleanup[0], /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{APP_ID\}"/);
  assert.match(cleanup[0], /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "\$\{APP_ID\}"/);
});

test('Windows startup cleanup identity and command match the packaged app and notification shortcut', async () => {
  const [main, build, installer, launcher] = await Promise.all([
    read('desktop/main.cjs'), read('scripts/build-desktop.mjs'),
    read('scripts/nsis/installer.nsh'), read('scripts/Install-HexiGrid-Launcher.ps1')
  ]);
  const appId = main.match(/app\.setAppUserModelId\('([^']+)'\)/)?.[1];
  assert.ok(appId, 'the Windows shell must set its AppUserModelId');
  assert.equal(build.match(/appId:\s*'([^']+)'/)?.[1], appId, 'installer APP_ID must match the shell AppUserModelId');
  assert.equal(installer.match(/-AppUserModelId "([^"]+)"/)?.[1], appId, 'toast shortcut must use the same AppUserModelId');
  assert.equal(launcher.match(/\$appId\s*=\s*'([^']+)'/)?.[1], appId, 'launcher shortcut must use the same AppUserModelId');
  assert.match(main, /getLoginItemSettings\(\{ path: process\.execPath, args: process\.platform === 'win32' \? \['--background'\] : \[\] \}\)/);
  assert.match(main, /updateLogin: enabled => process\.platform === 'linux'[\s\S]*?setLoginItemSettings\(\{ openAtLogin: enabled,[\s\S]*?args: \['--background'\]/);
  assert.match(installer, /StrCpy \$1 .*APP_EXECUTABLE_FILENAME.*--background/);
});

test('control-room startup guards package, runtime, network TLS, and identity failures before browser launch', async () => {
  const source = await read('Start-Control-Room.ps1');
  assert.match(source, /server\.mjs or package\.json is missing/);
  assert.match(source, /package\.name -ne "hexigrid"/);
  assert.match(source, /Node\.js 22 or newer is required/);
  assert.match(source, /HEXIGRID_PORT must be a whole number/);
  assert.match(source, /if \(-not \$hasPfx -and -not \$hasPemPair\)/);
  assert.match(source, /Port \$port is already used by another or unverifiable program/);
  assert.match(source, /HexiGrid did not pass its startup identity check/);
  assert.match(source, /Stop-Process -Id \$started\.Id/);
  assert.ok(source.indexOf('Confirm-HexiGridIdentity $identity ([int]$listener.OwningProcess)') < source.indexOf('Start-Process "$address/"'));
});

async function runWorker({ cacheName, existing = [], failInstall = false }) {
  const [rawPolicySource, rawWorkerSource] = await Promise.all([read('public/pwa-policy.js'), read('public/sw.js')]);
  const policySource = rawPolicySource.replace(/hexigrid-shell-v\d+/, cacheName);
  const workerSource = rawWorkerSource.replace(/hexigrid-shell-v\d+/, cacheName);
  const entries = new Map(existing.map((name) => [name, new Map([['/', new Response(`old:${name}`)]])]));
  const listeners = new Map();
  const caches = {
    async open(name) {
      if (!entries.has(name)) entries.set(name, new Map());
      const store = entries.get(name);
      return {
        async addAll(paths) {
          for (const asset of paths) {
            if (failInstall && asset === '/app.js') throw new Error('synthetic upgrade fetch failure');
            store.set(asset, new Response(`new:${asset}`));
          }
        },
        async put(request, response) { store.set(new URL(request.url).pathname, response); }
      };
    },
    async keys() { return [...entries.keys()]; },
    async delete(name) { return entries.delete(name); },
    async match(request) {
      const key = typeof request === 'string' ? request : new URL(request.url).pathname;
      for (const store of entries.values()) if (store.has(key)) return store.get(key);
      return undefined;
    }
  };
  const self = { location: { origin: 'https://hexigrid.local' }, clients: { async claim() {} }, async skipWaiting() {}, addEventListener(name, fn) { listeners.set(name, fn); } };
  const context = vm.createContext({ self, caches, Response, URL, fetch: async () => { throw new TypeError('offline'); }, importScripts() { vm.runInContext(policySource, context); self.HexiGridPwaPolicy = context.HexiGridPwaPolicy; } });
  context.globalThis = context;
  vm.runInContext(workerSource.replace(/hexigrid-shell-v\d+/, cacheName), context);
  return { listeners, caches, entries };
}

test('service-worker version upgrade failure preserves the previous offline shell', async () => {
  const { listeners, entries } = await runWorker({ cacheName: 'hexigrid-shell-v-next', existing: ['hexigrid-shell-v-old'], failInstall: true });
  let install;
  listeners.get('install')({ waitUntil(promise) { install = promise; } });
  await assert.rejects(install, /synthetic upgrade fetch failure/);
  assert.ok(entries.has('hexigrid-shell-v-old'));
  assert.equal((await entries.get('hexigrid-shell-v-old').get('/').text()), 'old:hexigrid-shell-v-old');
  // Browser lifecycle does not activate a worker whose install promise rejected.
});

test('successful worker activation retires old shell caches after the new version installs', async () => {
  const { listeners, entries } = await runWorker({ cacheName: 'hexigrid-shell-v-new', existing: ['hexigrid-shell-v-old'] });
  let install; listeners.get('install')({ waitUntil(promise) { install = promise; } }); await install;
  assert.ok(entries.has('hexigrid-shell-v-old'));
  let activate; listeners.get('activate')({ waitUntil(promise) { activate = promise; } }); await activate;
  assert.deepEqual([...entries.keys()], ['hexigrid-shell-v-new']);
  assert.ok(entries.get('hexigrid-shell-v-new').has('/app.js'));
});

test('Start Menu registration remains separate from explicit local release rollback', async () => {
  const scripts = await readFile(path.join(root, 'scripts', 'Install-HexiGrid-Launcher.ps1'), 'utf8');
  const packageJson = JSON.parse(await read('package.json'));
  assert.equal(packageJson.name, 'hexigrid');
  assert.doesNotMatch(scripts, /rollback|restore previous/i);
});
