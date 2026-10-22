const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const JSON_CHUNK = 0x4E4F534A;

function hasExternalUri(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasExternalUri);
  return Object.entries(value).some(([key, child]) => key === 'uri' || hasExternalUri(child));
}

export function validateAvatarModelData(value) {
  const match = /^data:model\/gltf-binary;base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) throw new Error('Choose a self-contained GLB 3D model.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 20 || bytes.length > MAX_MODEL_BYTES) throw new Error('The 3D avatar must be at most 64 MB.');
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('The file is not a valid GLB 2.0 model.');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || jsonLength < 2 || 20 + jsonLength > bytes.length) throw new Error('The GLB model has an invalid scene description.');
  let document;
  try { document = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)); }
  catch { throw new Error('The GLB scene description could not be read.'); }
  if (hasExternalUri(document)) throw new Error('The 3D avatar must be self-contained and cannot load outside files or URLs.');
  const vrmc = document.extensions?.VRMC_vrm;
  const legacyVrm = document.extensions?.VRM;
  let vrmVersion = '';
  if (vrmc) {
    if (vrmc.specVersion !== '1.0') throw new Error('This VRM version is not supported. Choose a VRM 1.0 model or convert it to GLB.');
    vrmVersion = '1.0';
  } else if (legacyVrm) {
    if (legacyVrm.specVersion !== '0.0') throw new Error('This VRM version is not supported. Choose a VRM 0.0 model or convert it to GLB.');
    vrmVersion = '0.0';
  } else if (Array.isArray(document.extensionsUsed) && document.extensionsUsed.some((name) => name === 'VRM' || name === 'VRMC_vrm')) {
    throw new Error('The file declares VRM metadata that is missing or unsupported.');
  }
  const animations = Array.isArray(document.animations) ? document.animations.slice(0, 100).map((clip, index) => String(clip.name || `animation_${index}`).slice(0, 120)) : [];
  return { bytes, mimeType: 'model/gltf-binary', animations, format: vrmVersion ? 'vrm' : 'glb', vrmVersion };
}

export const avatarModelLimits = Object.freeze({ maxBytes: MAX_MODEL_BYTES });
