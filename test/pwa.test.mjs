import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicRoot = path.join(root, 'public');
const expected = new Map([
  ['/icon-192.png', [192, 192, 'any']],
  ['/icon-512.png', [512, 512, 'any']],
  ['/icon-maskable-192.png', [192, 192, 'maskable']],
  ['/icon-maskable-512.png', [512, 512, 'maskable']]
]);

async function pngDimensions(file) {
  const bytes = await readFile(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10], `${file} must be a PNG`);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('PWA manifest has complete any-purpose and dedicated maskable raster icons', async () => {
  const manifest = JSON.parse(await readFile(path.join(publicRoot, 'manifest.webmanifest'), 'utf8'));
  for (const field of ['name', 'short_name', 'description', 'id', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) assert.ok(manifest[field], `${field} is required`);
  assert.equal(manifest.start_url, '/'); assert.equal(manifest.scope, '/'); assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['window-controls-overlay', 'standalone', 'minimal-ui']);
  assert.ok(manifest.icons.some((item) => item.src === '/icon.svg' && item.type === 'image/svg+xml'));
  assert.ok((await readFile(path.join(publicRoot, 'icon.svg'), 'utf8')).includes('wireframe icosahedron'));
  assert.ok((await stat(path.join(publicRoot, 'brand-icosahedron.svg'))).size > 1000);
  for (const [src, [width, height, purpose]] of expected) {
    const icon = manifest.icons.find((item) => item.src === src && item.purpose === purpose);
    assert.ok(icon, `${src} (${purpose}) must be declared`);
    assert.equal(icon.type, 'image/png'); assert.equal(icon.sizes, `${width}x${height}`);
    assert.deepEqual(await pngDimensions(path.join(publicRoot, src.slice(1))), [width, height]);
  }
});

test('iOS icons, splash screens, and offline shell assets are present and wired', async () => {
  const [html, worker, policy] = await Promise.all([readFile(path.join(publicRoot, 'index.html'), 'utf8'), readFile(path.join(publicRoot, 'sw.js'), 'utf8'), readFile(path.join(publicRoot, 'pwa-policy.js'), 'utf8')]);
  assert.match(html, /rel="apple-touch-icon"[^>]+apple-touch-icon-180\.png/);
  assert.match(html, /rel="apple-touch-startup-image"[^>]+splash-1170x2532\.png/);
  assert.match(html, /rel="apple-touch-startup-image"[^>]+splash-2048x2732\.png/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="theme-color" content="#090b10"/);
  assert.match(policy, /hexigrid-shell-v221/, 'changed shared UI modules invalidate the cached shell');
  assert.ok(policy.includes('/desktop-screen-capture.js'), 'screen-capture lifecycle changes must be fetched into the new shell');
  assert.deepEqual(await pngDimensions(path.join(publicRoot, 'apple-touch-icon-180.png')), [180, 180]);
  assert.deepEqual(await pngDimensions(path.join(publicRoot, 'splash-1170x2532.png')), [1170, 2532]);
  assert.deepEqual(await pngDimensions(path.join(publicRoot, 'splash-2048x2732.png')), [2048, 2732]);
  for (const asset of [...expected.keys(), '/apple-touch-icon-180.png', '/splash-1170x2532.png', '/splash-2048x2732.png']) {
    assert.match(policy, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok((await stat(path.join(publicRoot, asset.slice(1)))).size > 1000);
  }
  assert.match(worker, /request\.mode === 'navigate'/);
});

test('service-worker policy caches only same-origin static assets and excludes sensitive state', async () => {
  const source = await readFile(path.join(publicRoot, 'pwa-policy.js'), 'utf8');
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'pwa-policy.js' });
  const policy = context.HexiGridPwaPolicy;
  assert.ok(policy);
  assert.ok(policy.SHELL_ASSETS.includes('/'));
  assert.ok(policy.SHELL_ASSETS.includes('/pwa-connection.js'));
  assert.equal(policy.SHELL_ASSETS.includes('/agent-link/connect'), false);
  for (const asset of [...policy.SHELL_ASSETS, ...policy.LAZY_STATIC_ASSETS]) {
    const lower = asset.toLowerCase();
    assert.equal(policy.FORBIDDEN_FRAGMENTS.some((fragment) => lower.includes(fragment)), false, `${asset} must not be sensitive`);
    assert.equal(policy.isSafeCacheRequest({ method: 'GET', url: `https://hexigrid.local${asset}` }, 'https://hexigrid.local'), true);
  }
  for (const page of ['index.html', 'agent-interface.html']) {
    const html = await readFile(path.join(publicRoot, page), 'utf8');
    for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      assert.ok(policy.SHELL_ASSETS.includes(src), `${page}'s eager script ${src} must be available on cold offline load`);
    }
  }
  const rejected = [
    'https://hexigrid.local/api/bootstrap',
    'https://hexigrid.local/agent-link/connect',
    'https://hexigrid.local/memory/private.json',
    'https://hexigrid.local/audio/frame.webm',
    'https://hexigrid.local/app.js?token=secret',
    'https://other.example/app.js'
  ];
  for (const url of rejected) assert.equal(policy.isSafeCacheRequest({ method: 'GET', url }, 'https://hexigrid.local'), false, `${url} must not be cached`);
  assert.equal(policy.isSafeCacheRequest({ method: 'POST', url: 'https://hexigrid.local/app.js' }, 'https://hexigrid.local'), false);
});

test('synthetic offline worker serves the cached shell and never intercepts API requests', async () => {
  const [policySource, workerSource] = await Promise.all([
    readFile(path.join(publicRoot, 'pwa-policy.js'), 'utf8'),
    readFile(path.join(publicRoot, 'sw.js'), 'utf8')
  ]);
  const listeners = new Map();
  const stored = new Map();
  const cache = {
    async addAll(paths) { for (const item of paths) stored.set(item, new Response(`cached:${item}`)); },
    async put(request, response) { stored.set(new URL(request.url).pathname, response); }
  };
  const caches = {
    async open() { return cache; },
    async keys() { return ['older-shell']; },
    async delete() { return true; },
    async match(request) { return stored.get(new URL(typeof request === 'string' ? request : request.url, self.location.origin).pathname)?.clone(); }
  };
  const self = {
    location: { origin: 'https://hexigrid.local' },
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(name, handler) { listeners.set(name, handler); }
  };
  const context = vm.createContext({
    self, caches, Response, URL,
    fetch: async () => { throw new TypeError('synthetic offline'); },
    importScripts() {
      vm.runInContext(policySource, context, { filename: 'pwa-policy.js' });
      self.HexiGridPwaPolicy = context.HexiGridPwaPolicy;
    }
  });
  context.globalThis = context;
  vm.runInContext(workerSource, context, { filename: 'sw.js' });
  let installPromise;
  listeners.get('install')({ waitUntil(value) { installPromise = value; } });
  await installPromise;
  assert.ok(stored.has('/'));

  let responsePromise;
  listeners.get('fetch')({
    request: { method: 'GET', mode: 'navigate', url: 'https://hexigrid.local/' },
    respondWith(value) { responsePromise = value; },
    waitUntil() {}
  });
  assert.equal(await (await responsePromise).text(), 'cached:/');

  for (const [url, shell] of [
    ['https://hexigrid.local/#memory', '/'],
    ['https://hexigrid.local/agent-interface.html#memory-recall', '/agent-interface.html']
  ]) {
    responsePromise = undefined;
    listeners.get('fetch')({
      request: { method: 'GET', mode: 'navigate', url },
      respondWith(value) { responsePromise = value; },
      waitUntil() {}
    });
    assert.ok(responsePromise, 'hash-based navigation must retain cached shell recovery');
    assert.equal(await (await responsePromise).text(), `cached:${shell}`);
  }

  for (const request of [
    { method: 'GET', mode: 'cors', url: 'https://hexigrid.local/api/bootstrap' },
    { method: 'GET', mode: 'navigate', url: 'https://hexigrid.local/api/bootstrap#memory' },
    { method: 'GET', mode: 'navigate', url: 'https://hexigrid.local/?token=secret#memory' },
    { method: 'GET', mode: 'cors', url: 'https://hexigrid.local/app.js#secret' }
  ]) {
    let intercepted = false;
    listeners.get('fetch')({ request, respondWith() { intercepted = true; }, waitUntil() {} });
    assert.equal(intercepted, false, request.url);
  }
});

test('offline UI hides live state until a fresh bootstrap succeeds', async () => {
  const [html, connectivity, app, styles] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'pwa-connection.js'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8')
  ]);
  assert.match(html, /src="\/pwa-connection\.js"/);
  assert.match(connectivity, /navigator\.onLine === false \? 'offline' : 'verifying'/);
  assert.match(connectivity, /classList\.toggle\('app-disconnected', disconnected\)/);
  assert.match(connectivity, /panel\.hidden = !disconnected/);
  assert.match(connectivity, /function setInertScope\(/);
  assert.match(connectivity, /state\.scopes\.delete\(name\)/);
  assert.match(connectivity, /element\.inert = state\.wasInert/,
    'overlapping auth and connectivity covers restore the original inert state');
  assert.match(connectivity, /setInertScope\('auth', authVisible, \[authGate, panel\]\)/,
    'offline recovery stays accessible while the auth gate keeps app controls inert');
  assert.match(connectivity, /if \(!disconnected && authVisible\) focusAuthGate\(authGate\)/,
    'auth focus is restored after the startup connectivity check releases its inert cover');
  assert.match(connectivity, /Live status stays hidden until HexiGrid confirms a fresh connection/);
  assert.match(connectivity, /Reconnect to return to your workspace/,
    'offline guidance must not say the hidden workspace is available');
  assert.match(connectivity, /href="\/offline-help\.html"/, 'the fail-closed screen must offer cached help');
  const refresh = app.slice(app.indexOf('async function refresh()'), app.indexOf('document.addEventListener("click"'));
  assert.match(refresh, /markVerifying\(\)[\s\S]*state\.data = await api\("\/api\/bootstrap"\)[\s\S]*HexiGridConnectivity\?\.markOnline\(\)/,
    'live state stays hidden until the current bootstrap request succeeds');
  assert.match(styles, /\.offline-state\s*\{[\s\S]*position: fixed;[\s\S]*z-index: 12000;/);
});

test('offline help is a cached static recovery page without private workspace state', async () => {
  const [html, policy] = await Promise.all([
    readFile(path.join(publicRoot, 'offline-help.html'), 'utf8'),
    readFile(path.join(publicRoot, 'pwa-policy.js'), 'utf8')
  ]);
  assert.match(policy, /'\/offline-help\.html'/);
  assert.match(html, /Reconnect to return to HexiGrid/);
  assert.match(html, /old agent or device status/);
  assert.match(html, /check Activity before trying again/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /<script\b|\/api\/|agent-link|password|credential/i);
});

test('PWA install prompt is user-triggered and service worker registration is capability-gated', async () => {
  const app = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /data-action="install-pwa"|action === "install-pwa"/);
  assert.match(app, /"serviceWorker" in navigator/);
  assert.match(app, /beforeinstallprompt[\s\S]{0,180}preventDefault\(\)[\s\S]{0,180}deferredInstallPrompt/);
});

test('on-device browser inference is lazy, worker-backed, and included in the offline shell', async () => {
  const [html, inference, worker, serviceWorker, cachePolicy, staticAssets] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'on-device-inference.js'), 'utf8'),
    readFile(path.join(publicRoot, 'on-device-worker.js'), 'utf8'),
    readFile(path.join(publicRoot, 'sw.js'), 'utf8'),
    readFile(path.join(publicRoot, 'pwa-policy.js'), 'utf8'),
    readFile(path.join(root, 'lib', 'static-assets.mjs'), 'utf8')
  ]);
  assert.match(html, /src="\/on-device-inference\.js"/);
  assert.match(html, /src="\/on-device-chat\.js"/);
  assert.match(inference, /navigator\.gpu/);
  assert.match(inference, /new Worker\('\/on-device-worker\.js'/);
  assert.match(inference, /import\('\/vendor\/web-llm\.js'(?:\s*\+|\))/);
  assert.match(worker, /WebWorkerMLCEngineHandler/);
  assert.match(serviceWorker, /importScripts\('\/pwa-policy\.js'\)/);
  assert.match(cachePolicy, /'\/on-device-inference\.js'/);
  assert.match(cachePolicy, /'\/on-device-chat\.js'/);
  assert.match(cachePolicy, /'\/provider-limits\.mjs'/);
  assert.match(staticAssets, /'\/provider-limits\.mjs'/);
  assert.match(cachePolicy, /'\/vendor\/web-llm\.js'/);
  assert.match(staticAssets, /'\/vendor\/web-llm\.js'/);
  assert.ok((await stat(path.join(publicRoot, 'vendor', 'web-llm.js'))).size > 1000000);
});
