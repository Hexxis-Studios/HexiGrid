const { URL } = require('node:url');

function isAppUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function mediaKeys(permission, details = {}) {
  if (permission === 'notifications') return ['notifications'];
  if (permission === 'speaker-selection') return ['speaker'];
  if (permission !== 'media') return [];
  const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [details.mediaType];
  return [...new Set(types.map(type => ({ audio: 'microphone', video: 'camera' })[type]).filter(Boolean))];
}

function validIdentity(value, port) {
  return value?.product === 'hexigrid' && value.port === port && Number.isInteger(value.pid)
    && value.pid > 0 && /^[a-f0-9-]{36}$/i.test(value.instanceId || '')
    && /^[a-f0-9]{64}$/i.test(value.sourceDigest || '');
}

module.exports = { isAppUrl, externalUrl, mediaKeys, validIdentity };
