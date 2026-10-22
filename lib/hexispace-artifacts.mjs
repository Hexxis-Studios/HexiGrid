import crypto from 'node:crypto';
import { validateSafeLinkTarget } from './safe-link-preview.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_LINK_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PREVIEW_BYTES = 16 * 1024;
const ALLOWED_TYPES = new Set([
  'application/json', 'application/pdf', 'audio/mpeg', 'audio/ogg',
  'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'video/mp4'
]);

const clean = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const safeProviderUrl = (value) => {
  try { return validateSafeLinkTarget(value).toString(); } catch { return ''; }
};
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export const HEXISPACE_ARTIFACT_LIMITS = Object.freeze({
  maxBytes: MAX_BYTES,
  maxLinkBytes: MAX_LINK_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  minTtlSeconds: MIN_TTL_MS / 1000,
  maxTtlSeconds: MAX_TTL_MS / 1000,
  maxPreviewBytes: MAX_PREVIEW_BYTES
});

export function normalizeHexiSpaceArtifacts(state, now = Date.now()) {
  const artifacts = Array.isArray(state?.hexispace?.artifacts) ? state.hexispace.artifacts : [];
  if (state?.hexispace) state.hexispace.artifacts = artifacts
    .filter((item) => item && /^[a-z0-9-]{8,100}$/.test(String(item.id || '')))
    .map((item) => ({
      id: clean(item.id, 100),
      linkId: clean(item.linkId, 200),
      source: item.source === 'provider' ? 'provider' : 'local',
      filename: /^[a-z0-9-]{8,100}\.(?:bin|link)$/.test(String(item.filename || '')) ? item.filename : '',
      downloadName: safeFilename(item.downloadName),
      mimeType: typeof item.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mimeType) ? item.mimeType.toLowerCase() : 'application/octet-stream',
      providerUrl: safeProviderUrl(item.providerUrl),
      providerName: clean(item.providerName, 160),
      bytes: Number.isInteger(item.bytes) ? Math.min(MAX_BYTES, Math.max(0, item.bytes)) : 0,
      tokenHash: /^[A-Za-z0-9_-]{20,100}$/.test(String(item.tokenHash || '')) ? item.tokenHash : '',
      createdAt: clean(item.createdAt, 40),
      expiresAt: clean(item.expiresAt, 40),
      downloadCount: Number.isInteger(item.downloadCount) ? Math.min(100000, Math.max(0, item.downloadCount)) : 0,
      consentedAt: clean(item.consentedAt, 40)
    }))
    .filter((item) => item.linkId && item.tokenHash && Number.isFinite(Date.parse(item.expiresAt)) && (item.source === 'provider' ? /^https:\/\//i.test(item.providerUrl) : ALLOWED_TYPES.has(item.mimeType) && item.filename && item.bytes > 0));
  return state?.hexispace?.artifacts || [];
}

function decodeBody(body) {
  if (typeof body !== 'string' || !body || body.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) {
    const error = new Error('Artifact content is missing or larger than 10 MB.'); error.status = 413; throw error;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 === 1) {
    const error = new Error('Artifact content is not valid base64.'); error.status = 400; throw error;
  }
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) {
    const error = new Error('Artifact content is missing or larger than 10 MB.'); error.status = 413; throw error;
  }
  return bytes;
}

function safeFilename(value) {
  const normalized = clean(value, 160).replace(/[^A-Za-z0-9._ -]/g, '').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
  return normalized || 'download';
}

function ttlMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return MIN_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(seconds * 1000)));
}

function usedBytes(artifacts, linkId = '', now = Date.now()) {
  return artifacts.filter((item) => Date.parse(item.expiresAt) > now && (!linkId || item.linkId === linkId)).reduce((sum, item) => sum + item.bytes, 0);
}

export function pruneExpiredHexiSpaceArtifacts(state, now = Date.now()) {
  const artifacts = normalizeHexiSpaceArtifacts(state, now);
  const expired = artifacts.filter((item) => Date.parse(item.expiresAt) <= now);
  state.hexispace.artifacts = artifacts.filter((item) => Date.parse(item.expiresAt) > now);
  return expired;
}

export function createHexiSpaceArtifact(state, input = {}, now = Date.now()) {
  if (input.consent !== true) { const error = new Error('Explicit owner consent is required before publishing an artifact.'); error.status = 403; throw error; }
  const mimeType = clean(input.mimeType, 120).toLowerCase();
  const providerUrl = clean(input.providerUrl, 2000);
  let validatedProviderUrl = '';
  if (providerUrl) {
    try { validatedProviderUrl = validateSafeLinkTarget(providerUrl).toString(); }
    catch (error) { error.status = 400; throw error; }
    if (!mimeType || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) { const error = new Error('A provider-hosted artifact needs a valid MIME type.'); error.status = 415; throw error; }
  } else if (!ALLOWED_TYPES.has(mimeType)) {
    const error = new Error('This artifact type is not supported for safe download. HTML, SVG, scripts, and unknown types are not published.'); error.status = 415; throw error;
  }
  const bytes = providerUrl ? Buffer.alloc(0) : decodeBody(input.contentBase64);
  const artifacts = normalizeHexiSpaceArtifacts(state, now);
  if (usedBytes(artifacts, input.linkId, now) + bytes.length > MAX_LINK_BYTES) { const error = new Error('This HexiSpace connection has reached its 50 MB artifact quota.'); error.status = 413; throw error; }
  if (usedBytes(artifacts, '', now) + bytes.length > MAX_TOTAL_BYTES) { const error = new Error('The local HexiGrid artifact quota is full. Remove an existing artifact before publishing another.'); error.status = 413; throw error; }
  const id = `artifact-${crypto.randomUUID()}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs(input.expiresInSeconds)).toISOString();
  const record = { id, linkId: clean(input.linkId, 200), source: providerUrl ? 'provider' : 'local', filename: providerUrl ? `${id}.link` : `${id}.bin`, downloadName: safeFilename(input.filename), mimeType, providerUrl: validatedProviderUrl, providerName: clean(input.providerName, 160), bytes: bytes.length, tokenHash: digest(token), createdAt, expiresAt, downloadCount: 0, consentedAt: createdAt };
  if (!record.linkId) { const error = new Error('An approved HexiSpace connection is required.'); error.status = 400; throw error; }
  state.hexispace.artifacts.push(record);
  return { record, token, bytes };
}

export function authenticateHexiSpaceArtifact(state, id, token, now = Date.now()) {
  const record = normalizeHexiSpaceArtifacts(state, now).find((item) => item.id === clean(id, 100));
  if (!record || Date.parse(record.expiresAt) <= now || !safeEqual(record.tokenHash, digest(token))) {
    const error = new Error('This artifact link is invalid or expired.'); error.status = 401; throw error;
  }
  return record;
}

export function artifactPublicSummary(record, origin = '') {
  const summary = { id: record.id, source: record.source === 'provider' ? 'provider' : 'local', filename: record.downloadName || 'download', mimeType: record.mimeType, bytes: record.bytes, createdAt: record.createdAt, expiresAt: record.expiresAt };
  if (summary.source === 'provider') return { ...summary, providerName: record.providerName || '', externalUrl: record.providerUrl };
  return { ...summary, downloadUrl: `${String(origin).replace(/\/$/, '')}/api/hexispace/v1/artifacts/${encodeURIComponent(record.id)}/download` };
}

export function artifactQuotaSummary(state, linkId, now = Date.now()) {
  const artifacts = normalizeHexiSpaceArtifacts(state, now);
  return { linkBytes: usedBytes(artifacts, linkId, now), totalBytes: usedBytes(artifacts, '', now), linkLimitBytes: MAX_LINK_BYTES, totalLimitBytes: MAX_TOTAL_BYTES, activeArtifacts: artifacts.filter((item) => item.linkId === linkId && Date.parse(item.expiresAt) > now).length };
}

export function safeArtifactPreview(record, bytes) {
  if (record.source === 'provider') return { kind: 'external-link', text: '', truncated: false };
  if (!['text/plain', 'application/json'].includes(record.mimeType)) return { kind: 'download-only', text: '', truncated: false };
  const text = Buffer.from(bytes.subarray(0, MAX_PREVIEW_BYTES)).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
  return { kind: 'text', text, truncated: bytes.length > MAX_PREVIEW_BYTES };
}

export function artifactDownloadHeaders(record, filename) {
  const safeName = safeFilename(filename).replace(/"/g, '');
  return {
    'content-type': record.mimeType,
    'content-length': String(record.bytes),
    'content-disposition': `attachment; filename="${safeName}"`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff'
  };
}

export const HEXISPACE_ARTIFACT_TYPES = Object.freeze([...ALLOWED_TYPES]);
