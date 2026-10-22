// Disposable localhost-only visual fixture. No workspace, credentials or model API.
import http from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BoxGeometry, Mesh } from 'three';
import { DRACOExporter } from 'three/examples/jsm/exporters/DRACOExporter.js';
import { serveStaticAsset } from '../lib/static-assets.mjs';
import { AVATAR_VIEWER_STYLE_HASHES } from '../lib/avatar-viewer-style-hashes.mjs';
import { validateAvatarModelData } from '../lib/avatar-model.mjs';

const root = path.resolve(import.meta.dirname, '..');
const textureName = process.argv[3];
if (textureName && !['etc1s', 'uastc'].includes(textureName)) throw Error('Texture must be etc1s or uastc.');
const texture = textureName ? await readFile(path.join(root, 'test/fixtures/ktx2', `2d_${textureName}.ktx2`)) : null;
const encoderPath = path.join(root, 'node_modules/three/examples/jsm/libs/draco/gltf/draco_encoder.js');
const encoderContext = { module: { exports: {} }, exports: {}, process, console, Buffer, require: createRequire(import.meta.url), __filename: encoderPath, __dirname: path.dirname(encoderPath) };
vm.runInNewContext(await readFile(encoderPath, 'utf8'), encoderContext);
globalThis.DracoEncoderModule = encoderContext.module.exports;
const geometry = new BoxGeometry(1, 1, 1);
const compressed = Buffer.from(new DRACOExporter().parse(new Mesh(geometry), { exportUvs: Boolean(texture) }));
delete globalThis.DracoEncoderModule;
geometry.dispose();
const document = {
  asset: { version: '2.0', generator: 'HexiGrid synthetic decoder acceptance' },
  extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'],
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0,
    extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, NORMAL: 1 } } } }] }],
  accessors: [
    { componentType: 5126, count: geometry.attributes.position.count, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { componentType: 5126, count: geometry.attributes.normal.count, type: 'VEC3' },
    { componentType: 5123, count: geometry.index.count, type: 'SCALAR' }
  ],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.15, 0.8, 0.7, 1], metallicFactor: 0, roughnessFactor: 0.65 } }],
  buffers: [{ byteLength: compressed.length }], bufferViews: [{ buffer: 0, byteLength: compressed.length }]
};
const compressedPadding = Math.ceil(compressed.length / 4) * 4;
if (texture) {
  document.extensionsUsed.push('KHR_texture_basisu'); document.extensionsRequired.push('KHR_texture_basisu');
  document.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3;
  document.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.attributes.TEXCOORD_0 = 2;
  document.accessors.push({ componentType: 5126, count: geometry.attributes.uv.count, type: 'VEC2' });
  document.images = [{ bufferView: 1, mimeType: 'image/ktx2' }];
  document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
  document.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  document.bufferViews.push({ buffer: 0, byteOffset: compressedPadding, byteLength: texture.length });
  document.buffers[0].byteLength = compressedPadding + texture.length;
}
const jsonText = JSON.stringify(document);
const json = Buffer.from(jsonText.padEnd(Math.ceil(Buffer.byteLength(jsonText) / 4) * 4, ' '));
const binary = Buffer.alloc(Math.ceil(document.buffers[0].byteLength / 4) * 4); compressed.copy(binary);
if (texture) texture.copy(binary, compressedPadding);
const fixture = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
fixture.write('glTF'); fixture.writeUInt32LE(2, 4); fixture.writeUInt32LE(fixture.length, 8);
fixture.writeUInt32LE(json.length, 12); fixture.writeUInt32LE(0x4E4F534A, 16); json.copy(fixture, 20);
const offset = 20 + json.length;
fixture.writeUInt32LE(binary.length, offset); fixture.writeUInt32LE(0x004E4942, offset + 4); binary.copy(fixture, offset + 8);
validateAvatarModelData('data:model/gltf-binary;base64,' + fixture.toString('base64'));

// Use the current production header function, including its exact stylesheet hashes.
const serverSource = await readFile(path.join(root, 'server.mjs'), 'utf8');
const start = serverSource.indexOf('function securityHeaders('), end = serverSource.indexOf('\nfunction json(', start);
if (start < 0 || end < start) throw Error('Production security headers could not be located.');
const context = vm.createContext({ embeddedDocumentHeaders: () => ({}), AVATAR_VIEWER_STYLE_HASHES, TLS_ENABLED: false });
vm.runInContext(serverSource.slice(start, end), context);
const headers = context.securityHeaders;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HexiGrid local decoder acceptance</title><link rel="stylesheet" href="/fixture.css"><script src="/avatar-viewer.js" defer></script><script src="/fixture.js" defer></script></head><body><main><h1>Local compressed avatar</h1><p>Synthetic Draco cube · current HexiGrid viewer and security headers · no account data</p><p id="status" role="status">Loading compressed model…</p><div id="body"></div><button id="broken">Test invalid model</button><button id="retry">Load valid model</button></main></body></html>`;
const client = `const body=document.querySelector('#body'),status=document.querySelector('#status');function show(source){status.textContent='Loading compressed model…';body.innerHTML=window.HexiGridAvatarViewer.element(source,'Synthetic compressed cube');const model=body.querySelector('model-viewer');model.addEventListener('load',()=>{status.textContent='Compressed model loaded locally.'});model.addEventListener('error',()=>{status.textContent='Model could not load. Choose Load valid model to recover.'});}document.querySelector('#broken').onclick=()=>show('/broken.glb');document.querySelector('#retry').onclick=()=>show('/fixture.glb');show('/fixture.glb');`;
const css = `body{margin:0;background:#10141f;color:#e8eef8;font:16px system-ui}main{max-width:800px;margin:auto;padding:24px}h1{font-size:28px}p{line-height:1.5}model-viewer{display:block;width:100%;height:400px;background:#1e2636;border-radius:16px}button{padding:12px 18px;margin:16px 8px 0 0;border:1px solid #78d8cf;border-radius:8px;background:#293248;color:white}`;
const routes = new Map();
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  routes.set(pathname, (routes.get(pathname) || 0) + 1);
  function send(type, body) { res.writeHead(200, headers(type)); res.end(body); }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (pathname === '/') return send('text/html', textureName ? page.replace('Synthetic Draco cube', `Synthetic Draco cube + ${textureName} KTX2 texture`) : page);
  if (pathname === '/fixture.js') return send('text/javascript', `const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.addEventListener('error',event=>{document.querySelector('#status').textContent='Decoder worker failed: '+event.message;});}};` + client);
  if (pathname === '/fixture.css') return send('text/css', css);
  if (pathname === '/fixture.glb') return send('model/gltf-binary', fixture);
  if (pathname === '/broken.glb') return send('model/gltf-binary', Buffer.from('synthetic-invalid-model'));
  if (pathname === '/evidence') return send('application/json', JSON.stringify({ texture: textureName || null, textureBytes: texture?.length || 0, fixtureBytes: fixture.length, compressedBytes: compressed.length, routes: Object.fromEntries(routes) }));
  try {
    if (await serveStaticAsset({ method: req.method, pathname, res, publicDir: path.join(root, 'public'), securityHeaders: headers, serveHtml() { throw Error('Unexpected HTML'); } })) return;
  } catch { res.writeHead(500); res.end('Fixture asset unavailable'); return; }
  res.writeHead(404); res.end();
});
const port = Number(process.argv[2] || 44678);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Use a localhost port from 1024 to 65535.');
server.listen(port, '127.0.0.1', () => console.log(`Synthetic decoder fixture ready at http://127.0.0.1:${port}; ${fixture.length} GLB bytes.`));
