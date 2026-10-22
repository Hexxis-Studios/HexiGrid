import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { validateAvatarModelData } from '../lib/avatar-model.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const viewerSource = await readFile(path.join(root, 'public', 'avatar-viewer.js'));
const vrmBundle = await readFile(path.join(root, 'public', 'vendor', 'vrm-viewer.js'));
const vrmCss = await readFile(path.join(root, 'public', 'vendor', 'vrm-viewer.css'));
const fixture = syntheticVrm();
validateAvatarModelData(`data:model/gltf-binary;base64,${fixture.toString('base64')}`);

function syntheticVrm() {
  const vertices = [
    [-0.42, 0.1, -0.22], [0.42, 0.1, -0.22], [0.42, 1.12, -0.22], [-0.42, 1.12, -0.22],
    [-0.42, 0.1, 0.22], [0.42, 0.1, 0.22], [0.42, 1.12, 0.22], [-0.42, 1.12, 0.22]
  ];
  const target = vertices.map(([x, y, z]) => [0, y > 1 ? 0.18 : 0, 0]);
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
  const bones = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
  const positions = Buffer.from(new Float32Array(vertices.flat()).buffer);
  const elements = Buffer.from(new Uint16Array(indices).buffer);
  const deltas = Buffer.from(new Float32Array(target.flat()).buffer);
  const pad = (buffer, alignment = 4, value = 0) => Buffer.concat([buffer, Buffer.alloc((alignment - buffer.length % alignment) % alignment, value)]);
  const chunks = [pad(positions), pad(elements), pad(deltas)];
  let offset = 0;
  const views = chunks.map((chunk, index) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: chunk.length };
    if (index === 1) view.target = 34963;
    if (index !== 1) view.target = 34962;
    offset += chunk.length;
    return view;
  });
  const document = {
    asset: { version: '2.0', generator: 'HexiGrid isolated visual QA fixture' },
    extensionsUsed: ['VRMC_vrm'],
    extensions: { VRMC_vrm: {
      specVersion: '1.0',
      meta: { name: 'Synthetic HexiGrid QA Avatar', version: '1.0', authors: ['HexiGrid QA'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
      humanoid: { humanBones: Object.fromEntries(bones.map((name, index) => [name, { node: index }])) },
      expressions: { preset: { happy: { morphTargetBinds: [{ node: 0, index: 0, weight: 1 }] } } }
    } },
    buffers: [{ byteLength: positions.length + elements.length + deltas.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.42, 0.1, -0.22], max: [0.42, 1.12, 0.22] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [0, 0.18, 0] }
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.34, 0.56, 0.94, 1], metallicFactor: 0, roughnessFactor: 0.62 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, targets: [{ POSITION: 2 }] }], weights: [0] }],
    nodes: [
      { name: 'Hips', mesh: 0, children: [1, 3, 6] },
      { name: 'Spine', translation: [0, 0.55, 0], children: [2, 9, 12] },
      { name: 'Head', translation: [0, 0.78, 0], scale: [0.42, 0.42, 0.42], mesh: 0 },
      { name: 'Left upper leg', translation: [-0.22, -0.05, 0], scale: [0.26, 0.48, 0.42], mesh: 0, children: [4] },
      { name: 'Left lower leg', translation: [0, -0.48, 0], scale: [0.22, 0.46, 0.38], mesh: 0, children: [5] },
      { name: 'Left foot', translation: [0, -0.42, 0.08], scale: [0.24, 0.15, 0.55], mesh: 0 },
      { name: 'Right upper leg', translation: [0.22, -0.05, 0], scale: [0.26, 0.48, 0.42], mesh: 0, children: [7] },
      { name: 'Right lower leg', translation: [0, -0.48, 0], scale: [0.22, 0.46, 0.38], mesh: 0, children: [8] },
      { name: 'Right foot', translation: [0, -0.42, 0.08], scale: [0.24, 0.15, 0.55], mesh: 0 },
      { name: 'Left upper arm', translation: [-0.5, 0.36, 0], scale: [0.24, 0.42, 0.42], mesh: 0, children: [10] },
      { name: 'Left lower arm', translation: [-0.38, -0.03, 0], scale: [0.2, 0.4, 0.36], mesh: 0, children: [11] },
      { name: 'Left hand', translation: [-0.28, -0.02, 0], scale: [0.24, 0.18, 0.28], mesh: 0 },
      { name: 'Right upper arm', translation: [0.5, 0.36, 0], scale: [0.24, 0.42, 0.42], mesh: 0, children: [13] },
      { name: 'Right lower arm', translation: [0.38, -0.03, 0], scale: [0.2, 0.4, 0.36], mesh: 0, children: [14] },
      { name: 'Right hand', translation: [0.28, -0.02, 0], scale: [0.24, 0.18, 0.28], mesh: 0 }
    ], scenes: [{ nodes: [0] }], scene: 0
  };
  const json = pad(Buffer.from(JSON.stringify(document)), 4, 0x20);
  const binary = Buffer.concat(chunks);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const result = Buffer.alloc(total);
  result.write('glTF', 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(total, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20);
  const binaryOffset = 20 + json.length;
  result.writeUInt32LE(binary.length, binaryOffset); result.writeUInt32LE(0x004e4942, binaryOffset + 4); binary.copy(result, binaryOffset + 8);
  return result;
}

const qaCss = `*{box-sizing:border-box}body{margin:0;padding:24px;background:#111523;color:#e9edff;font:15px system-ui,sans-serif}main{max-width:960px;margin:auto}.eyebrow{color:#9da9ca;font-size:11px;letter-spacing:.14em}h1{margin:.4rem 0}p{color:#c7cde0}.tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0}label{display:grid;gap:5px;color:#c7cde0;font-size:12px}select,button{min-height:40px;padding:8px 12px;border:1px solid #586281;border-radius:8px;background:#20283c;color:#fff;font:inherit}button{cursor:pointer}.frame{height:min(62vh,520px);min-height:300px;border:1px solid #465273;border-radius:18px;background:radial-gradient(ellipse at 50% 92%,#563e8a77,transparent 60%),linear-gradient(#2a3451 1px,transparent 1px),linear-gradient(90deg,#2a3451 1px,transparent 1px);background-size:auto,60px 60px,60px 60px}.frame hexi-vrm-viewer{width:100%;height:100%}[role=status]{min-height:24px;color:#a7d6ce}.note{font-size:12px;color:#99a4bf}`;
const qaJs = `const root=document.querySelector('#viewer'),status=document.querySelector('#status'),expressions=document.querySelector('#expression');let generation=0;async function load(path='/synthetic.vrm'){const current=++generation;status.textContent='Loading local synthetic VRM…';root.innerHTML=window.HexiGridAvatarViewer.element(path,'Synthetic QA Avatar','', 'vrm');await window.HexiGridAvatarViewer.ensureVrmLoaded();const model=root.querySelector('hexi-vrm-viewer');model.addEventListener('load',()=>{if(current!==generation)return;const list=model.availableExpressions||[];expressions.innerHTML='<option value="">Model default</option>'+list.map(x=>'<option value="'+x+'">'+x+'</option>').join('');status.textContent='Loaded · VRM · '+(model.availableAnimations.length?'animation ready':'no embedded animations')+' · '+(list.length?list.length+' supported emotion':'no optional emotion')+' · local-only fixture';});model.addEventListener('error',()=>{if(current===generation)status.textContent='Load failed · '+(model.shadowRoot.querySelector('.error')?.textContent||'inspect browser console')});}expressions.addEventListener('change',()=>root.querySelector('hexi-vrm-viewer')?.setAttribute('expression',expressions.value));document.querySelector('#reload').addEventListener('click',()=>load());document.querySelector('#broken').addEventListener('click',()=>load('/missing.vrm'));load();`;

const assets = new Map([
  ['/avatar-viewer.js', ['text/javascript; charset=utf-8', viewerSource]],
  ['/vendor/vrm-viewer.js', ['text/javascript; charset=utf-8', vrmBundle]],
  ['/vendor/vrm-viewer.css', ['text/css; charset=utf-8', vrmCss]],
  ['/synthetic.vrm', ['model/gltf-binary', fixture]],
  ['/qa.css', ['text/css; charset=utf-8', qaCss]],
  ['/qa.js', ['text/javascript; charset=utf-8', qaJs]]
]);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disposable VRM visual QA</title><link rel="stylesheet" href="/qa.css"><main><div class="eyebrow">ISOLATED LOCAL VISUAL QA</div><h1>Synthetic VRM avatar</h1><p>This hand-built fixture is stored in memory only. Its single supported emotion changes the mesh locally; no account, user model, API or world connector is involved.</p><div class="tools"><label>Supported expression<select id="expression"><option value="">Waiting for VRM…</option></select></label><button id="reload" type="button">Reload avatar</button><button id="broken" type="button">Show load error</button></div><div id="viewer" class="frame"></div><p id="status" role="status" aria-live="polite">Starting local viewer…</p><p class="note">Drag the avatar to orbit. Press the broken-model button to check recovery, then reload to verify restoration.</p></main><script src="/avatar-viewer.js" defer></script><script src="/qa.js" defer></script></html>`;
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const asset = assets.get(pathname);
  if (req.method !== 'GET' || (pathname !== '/' && !asset)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
  const [type, body] = pathname === '/' ? ['text/html; charset=utf-8', html] : asset;
  res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'content-security-policy': csp });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(`Disposable VRM visual QA: http://127.0.0.1:${server.address().port}/`));
process.stdin.resume();
process.stdin.on('data', data => { if (String(data).includes('stop')) server.close(() => process.exit(0)); });
