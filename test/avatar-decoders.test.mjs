import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStaticAsset } from '../lib/static-assets.mjs';

test('compressed avatar decoder assets are served locally with correct types and exact package bytes', async () => {
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  for (const [family, filenames] of Object.entries({ draco: ['draco_decoder.js', 'draco_wasm_wrapper.js', 'draco_decoder.wasm'], basis: ['basis_transcoder.js', 'basis_transcoder.wasm'] })) {
    for (const filename of filenames) {
      let headers, body;
      const res = { writeHead(status, h) { assert.equal(status, 200); headers = h; }, end(b) { body = b; } };
      assert.equal(await serveStaticAsset({ method: 'GET', pathname: `/vendor/${family}/${filename}`, res, publicDir, securityHeaders: type => ({ 'content-type': type }), serveHtml() { throw Error('not HTML'); } }), true);
      const source = await readFile(new URL(`../node_modules/three/examples/jsm/libs/${family}/${family === 'draco' ? 'gltf/' : ''}${filename}`, import.meta.url));
      assert.deepEqual(body, source);
      assert.equal(headers['content-type'], filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
      if (filename.endsWith('.wasm')) assert.ok(await WebAssembly.compile(body));
    }
  }
});

test('lazy avatar configuration sets local decoder locations before first import', async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await readFile(new URL('../public/avatar-viewer.js', import.meta.url), 'utf8'), context);
  context.window.HexiGridAvatarViewer.element('/synthetic.glb', 'Synthetic');
  assert.equal(context.window.ModelViewerElement.dracoDecoderLocation, '/vendor/draco/');
  assert.equal(context.window.ModelViewerElement.ktx2TranscoderLocation, '/vendor/basis/');
});

test('actual owner CSP permits local WASM and blob decoder workers without JavaScript eval or remote workers', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function securityHeaders('), end = source.indexOf('\nfunction json(', start);
  const context = vm.createContext({ embeddedDocumentHeaders: () => ({}), AVATAR_VIEWER_STYLE_HASHES: [], TLS_ENABLED: false });
  vm.runInContext(source.slice(start, end), context);
  const policy = vm.runInContext("securityHeaders('text/html')['content-security-policy']", context);
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval' https:\/\/apis.google.com;/);
  assert.match(policy, /worker-src 'self' blob:;/);
  assert.doesNotMatch(policy, /'unsafe-eval'|'unsafe-inline'|worker-src[^;]*https/);
});

test('only the fixed Basis worker permits generated invokers, with network and child workers denied', async () => {
  let headers, body;
  const res = { writeHead(status, value) { assert.equal(status, 200); headers = value; }, end(value) { body = value; } };
  await serveStaticAsset({ method: 'GET', pathname: '/vendor/basis/worker.js', res,
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
    securityHeaders: type => ({ 'content-type': type, 'content-security-policy': "script-src 'self'" }), serveHtml() {} });
  assert.match(headers['content-security-policy'], /script-src 'unsafe-eval' 'wasm-unsafe-eval';/);
  assert.match(headers['content-security-policy'], /default-src 'none';/);
  assert.match(headers['content-security-policy'], /connect-src 'none'; worker-src 'none';/);
  assert.doesNotMatch(headers['content-security-policy'], /https?:|blob:|'unsafe-inline'/);
  const wrapper = await readFile(new URL('../public/vendor/basis/basis_transcoder.js', import.meta.url), 'utf8');
  assert.ok(body.toString().includes(wrapper));
  const bundle = await readFile(new URL('../public/vendor/model-viewer.js', import.meta.url), 'utf8');
  assert.match(bundle, /workerSourceURL="\/vendor\/basis\/worker\.js"/);
});
