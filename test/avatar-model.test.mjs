import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAvatarModelData } from '../lib/avatar-model.mjs';

function glb(document, jsonPadding = 0x20) {
  const raw = Buffer.from(JSON.stringify(document));
  const padding = Buffer.alloc((4 - (raw.length % 4)) % 4, jsonPadding);
  const json = Buffer.concat([raw, padding]);
  const result = Buffer.alloc(20 + json.length);
  result.write('glTF', 0, 'ascii'); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4E4F534A, 16); json.copy(result, 20);
  return `data:model/gltf-binary;base64,${result.toString('base64')}`;
}

test('3D avatar accepts a bounded self-contained GLB 2.0 scene', () => {
  const result = validateAvatarModelData(glb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }));
  assert.equal(result.mimeType, 'model/gltf-binary');
  assert.equal(result.bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(result.format, 'glb');
});

test('VRM 1.0 and legacy VRM metadata are distinguished inside self-contained GLB containers', () => {
  const vrm1 = validateAvatarModelData(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { specVersion: '1.0' } } }));
  assert.deepEqual({ format: vrm1.format, vrmVersion: vrm1.vrmVersion }, { format: 'vrm', vrmVersion: '1.0' });
  const vrm0 = validateAvatarModelData(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRM'], extensions: { VRM: { specVersion: '0.0' } } }));
  assert.deepEqual({ format: vrm0.format, vrmVersion: vrm0.vrmVersion }, { format: 'vrm', vrmVersion: '0.0' });
});

test('unsupported or incomplete VRM metadata fails instead of falling through to generic GLB rendering', () => {
  assert.throws(() => validateAvatarModelData(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { specVersion: '2.0' } } })), /version is not supported/);
  assert.throws(() => validateAvatarModelData(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRM'], extensions: { VRM: { specVersion: '0.1' } } })), /VRM 0.0/);
  assert.throws(() => validateAvatarModelData(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRM'] })), /metadata that is missing/);
});

test('3D avatar rejects malformed files and every outside URI', () => {
  assert.throws(() => validateAvatarModelData('data:model/gltf-binary;base64,bm90LWEtZ2xi'), /at most|valid GLB/);
  const badPadding = Buffer.from(glb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }, 0).slice('data:model/gltf-binary;base64,'.length), 'base64');
  assert.throws(() => validateAvatarModelData(`data:model/gltf-binary;base64,${badPadding.toString('base64')}`), /scene description could not be read/);
  assert.throws(() => validateAvatarModelData(glb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.test/model.bin' }] })), /self-contained/);
  assert.throws(() => validateAvatarModelData(glb({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,AA==' }] })), /self-contained/);
});
