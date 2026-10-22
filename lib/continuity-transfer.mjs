import crypto from 'node:crypto';
import { assertContinuitySafe, normalizeContinuityPath } from './continuity-security.mjs';

export const CONTINUITY_CATEGORIES = Object.freeze([
  'identity', 'personality', 'memories', 'parentRelationship', 'conversations',
  'relationships', 'commitments', 'goals', 'recurringWork', 'skills', 'files',
  'artifacts', 'workspace', 'voice', 'avatar', 'publicHistory', 'toolPreferences',
  'capabilities', 'platformAssets'
]);
export const REQUIRED_CONTINUITY_CATEGORIES = Object.freeze([
  'identity', 'personality', 'memories', 'parentRelationship', 'conversations',
  'relationships', 'commitments', 'goals', 'skills', 'workspace', 'voice',
  'avatar', 'toolPreferences', 'capabilities'
]);
export const CONTINUITY_FORMAT = 'hexigrid-continuity';
export const CURRENT_CONTINUITY_VERSION = 2;

const STATUSES = new Set(['complete', 'partial', 'unavailable', 'platform-bound']);
const MAX_CATEGORY_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_FILES = 64;
const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_TOTAL_BYTES = 8 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(['application/json', 'text/markdown', 'text/plain']);

const clean = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const stableContinuityJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableContinuityJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableContinuityJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const continuityDigest = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableContinuityJson(value)).digest('hex');

function iso(value, fallback = new Date().toISOString()) {
  return Number.isFinite(Date.parse(String(value || ''))) ? new Date(value).toISOString() : fallback;
}
function boundedData(value) {
  const serialized = stableContinuityJson(value ?? null);
  if (Buffer.byteLength(serialized) > MAX_CATEGORY_BYTES) throw new Error('A continuity category is too large. Split large files into separately reviewed content files.');
  return JSON.parse(serialized);
}

export function normalizeContinuitySnapshot(input = {}) {
  const source = input.categories && typeof input.categories === 'object' ? input.categories : {};
  const categories = {};
  for (const name of CONTINUITY_CATEGORIES) {
    const item = source[name] && typeof source[name] === 'object' ? source[name] : {};
    categories[name] = {
      status: STATUSES.has(item.status) ? item.status : 'unavailable',
      summary: clean(item.summary, 2000), reason: clean(item.reason, 1000), data: boundedData(item.data)
    };
  }
  return {
    schemaVersion: 1,
    source: { framework: clean(input.source?.framework, 80) || 'unknown', externalId: clean(input.source?.externalId, 200), name: clean(input.source?.name, 120) || 'Existing agent' },
    categories, createdAt: iso(input.createdAt)
  };
}

export function continuityCompleteness(snapshot) {
  const normalized = normalizeContinuitySnapshot(snapshot);
  const missingRequired = REQUIRED_CONTINUITY_CATEGORIES.filter((name) => normalized.categories[name].status !== 'complete');
  return { complete: missingRequired.length === 0, missingRequired, categories: Object.fromEntries(CONTINUITY_CATEGORIES.map((name) => [name, normalized.categories[name].status])) };
}

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Use a continuity passphrase with at least 12 characters.');
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}
function encryptPayload(payload, passphrase, metadata = {}) {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: CONTINUITY_FORMAT, version: metadata.version, kdf: 'scrypt', cipher: 'aes-256-gcm',
    salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url'), createdAt: metadata.createdAt,
    ...(metadata.backupId ? { backupId: metadata.backupId } : {}), ...(metadata.lineageId ? { lineageId: metadata.lineageId } : {})
  };
}
function decryptPayload(envelope, passphrase) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(envelope.salt, 'base64url')), Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8'));
}
function signManifest(manifest) {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    signature: crypto.sign(null, Buffer.from(continuityDigest(manifest), 'hex'), keys.privateKey).toString('base64url')
  };
}
function verifyManifest(manifest, publicKey, signature) {
  try { return crypto.verify(null, Buffer.from(continuityDigest(manifest), 'hex'), crypto.createPublicKey(publicKey), Buffer.from(signature, 'base64url')); }
  catch { return false; }
}
function normalizeRuntime(value = {}) {
  return { model: clean(value.model, 200), provider: clean(value.provider, 120), harness: clean(value.harness, 120), framework: clean(value.framework, 120) };
}
function normalizeLineage(value = {}, snapshot = {}) {
  return {
    id: /^lineage-[0-9a-f-]{36}$/i.test(String(value.id || '')) ? String(value.id).toLowerCase() : `lineage-${crypto.randomUUID()}`,
    generation: Math.max(0, Math.floor(Number(value.generation) || 0)), parentBackupId: clean(value.parentBackupId, 160) || null,
    sourceAgentId: clean(value.sourceAgentId, 160) || null, sourceExternalId: clean(value.sourceExternalId || snapshot.source?.externalId, 200) || null,
    sourceActivityState: value.sourceActivityState === 'suspended' ? 'suspended' : 'active', createdAt: iso(value.createdAt || snapshot.createdAt),
    restoreHistory: Array.isArray(value.restoreHistory) ? value.restoreHistory.slice(-50).map((item) => ({ backupId: clean(item?.backupId, 160), restoredAt: iso(item?.restoredAt), model: clean(item?.model, 200), provider: clean(item?.provider, 120), harness: clean(item?.harness, 120) })) : []
  };
}
function normalizeMemorySyncReference(value, lineageId) {
  if (value == null) return null;
  if (value?.format !== 'hexigrid-memory-sync' || value?.version !== 1 || !/^memory-sync-[0-9a-f-]{36}$/i.test(String(value.syncId || '')) || String(value.lineageId || '').toLowerCase() !== lineageId) throw new Error('The continuity memory-sync reference is invalid.');
  if (!Array.isArray(value.files) || value.files.length > 10000) throw new Error('The continuity memory-sync file index is invalid.');
  const seen = new Set(); let totalBytes = 0;
  const files = value.files.map((file) => {
    const filePath = String(file?.path || '').replaceAll('\\', '/');
    const bytes = Number(file?.bytes); const sha256 = String(file?.sha256 || '').toLowerCase();
    if (!new RegExp(`^${lineageId.replaceAll('-', '\\-')}\\/\\d{4}-\\d{2}-\\d{2}\\.json$`, 'i').test(filePath) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256) || seen.has(filePath)) throw new Error('The continuity memory-sync file index is invalid.');
    seen.add(filePath); totalBytes += bytes;
    if (totalBytes > 512 * 1024 * 1024) throw new Error('The continuity memory-sync file index is too large.');
    return { path: filePath, bytes, sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const rootDigest = continuityDigest(files);
  if (String(value.rootDigest || '').toLowerCase() !== rootDigest || Number(value.totalBytes) !== totalBytes || value.sourceActivityState !== 'suspended') throw new Error('The continuity memory-sync digest or source state is invalid.');
  return { format: 'hexigrid-memory-sync', version: 1, syncId: String(value.syncId).toLowerCase(), lineageId, sourceAgentId: clean(value.sourceAgentId, 160), sourceActivityState: 'suspended', createdAt: iso(value.createdAt), files, totalBytes, rootDigest };
}
function normalizeContentFiles(files = []) {
  if (!Array.isArray(files)) throw new Error('Continuity content files must be a list.');
  if (files.length > MAX_CONTENT_FILES) throw new Error(`A continuity package can contain at most ${MAX_CONTENT_FILES} content files.`);
  const seen = new Set(); let total = 0;
  return files.map((input) => {
    if (input?.type === 'symlink' || input?.kind === 'symlink' || input?.symlink === true || typeof input?.target === 'string') throw new Error('Continuity content cannot include symbolic links.');
    const filePath = normalizeContinuityPath(input?.path);
    if (seen.has(filePath.toLowerCase())) throw new Error('Continuity content paths must be unique.');
    seen.add(filePath.toLowerCase());
    const mediaType = clean(input?.mediaType, 100) || 'text/plain';
    if (!ALLOWED_CONTENT_TYPES.has(mediaType)) throw new Error('Continuity content must be JSON, Markdown, or plain text.');
    if (typeof input?.content !== 'string') throw new Error('Continuity content files must contain UTF-8 text.');
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > MAX_CONTENT_FILE_BYTES) throw new Error('A continuity content file is larger than 2 MB.');
    total += bytes;
    if (total > MAX_CONTENT_TOTAL_BYTES) throw new Error('Continuity content files are larger than 8 MB together.');
    return { path: filePath, mediaType, content: input.content };
  });
}
function categoryFiles(snapshot) {
  return CONTINUITY_CATEGORIES.map((category) => ({ path: `categories/${category}.json`, mediaType: 'application/json', content: stableContinuityJson(snapshot.categories[category]) }));
}

function createLegacyPackage(snapshot, passphrase) {
  const normalized = normalizeContinuitySnapshot(snapshot); const completeness = continuityCompleteness(normalized);
  if (!completeness.complete) throw new Error(`Continuity transfer stopped. Complete these required categories first: ${completeness.missingRequired.join(', ')}.`);
  assertContinuitySafe(normalized);
  const manifest = {
    format: CONTINUITY_FORMAT, schemaVersion: 1, source: normalized.source, createdAt: normalized.createdAt, payloadDigest: continuityDigest(normalized),
    categories: Object.fromEntries(CONTINUITY_CATEGORIES.map((name) => [name, { status: normalized.categories[name].status, digest: continuityDigest(normalized.categories[name]) }]))
  };
  return encryptPayload({ manifest, ...signManifest(manifest), snapshot: normalized }, passphrase, { version: 1, createdAt: normalized.createdAt });
}

export function createContinuityPackage(snapshot, passphrase, options = {}) {
  if (options.version === 1) return createLegacyPackage(snapshot, passphrase);
  const normalized = normalizeContinuitySnapshot(snapshot); const completeness = continuityCompleteness(normalized);
  if (!completeness.complete) throw new Error(`Continuity transfer stopped. Complete these required categories first: ${completeness.missingRequired.join(', ')}.`);
  assertContinuitySafe(normalized);
  const lineage = normalizeLineage(options.lineage, normalized); const backupId = `continuity-backup-${crypto.randomUUID()}`;
  const extras = normalizeContentFiles(options.contentFiles || []);
  const files = normalizeContentFiles([...categoryFiles(normalized), ...extras]);
  assertContinuitySafe(files);
  const fileRecords = files.map((file, index) => ({ path: file.path, mediaType: file.mediaType, role: index < CONTINUITY_CATEGORIES.length ? 'category' : 'content', ...(index < CONTINUITY_CATEGORIES.length ? { category: CONTINUITY_CATEGORIES[index] } : {}), bytes: Buffer.byteLength(file.content, 'utf8'), sha256: continuityDigest(file.content) }));
  const createdAt = new Date().toISOString();
  const memorySync = normalizeMemorySyncReference(options.memorySyncManifest, lineage.id);
  const manifest = {
    format: CONTINUITY_FORMAT, schemaVersion: 2, backupId, createdAt, source: normalized.source, runtime: normalizeRuntime(options.runtime), lineage,
    requiredCategories: [...REQUIRED_CONTINUITY_CATEGORIES], files: fileRecords,
    payloadDigest: continuityDigest(fileRecords.map(({ path, sha256 }) => ({ path, sha256 }))),
    ...(memorySync ? { memorySync } : {})
  };
  return encryptPayload({ manifest, ...signManifest(manifest), files }, passphrase, { version: 2, createdAt, backupId, lineageId: lineage.id });
}

function openLegacyPackage(envelope, decoded) {
  if (decoded.manifest?.format !== CONTINUITY_FORMAT || decoded.manifest.payloadDigest !== continuityDigest(decoded.snapshot)) throw new Error('The continuity package contents were changed.');
  if (!verifyManifest(decoded.manifest, decoded.publicKey, decoded.signature)) throw new Error('The continuity package signature is invalid.');
  const normalized = normalizeContinuitySnapshot(decoded.snapshot); const completeness = continuityCompleteness(normalized);
  if (!completeness.complete) throw new Error(`Continuity transfer stopped. Required data is incomplete: ${completeness.missingRequired.join(', ')}.`);
  for (const name of CONTINUITY_CATEGORIES) if (decoded.manifest.categories?.[name]?.digest !== continuityDigest(normalized.categories[name])) throw new Error(`The ${name} continuity category failed verification.`);
  assertContinuitySafe(normalized);
  return { manifest: decoded.manifest, snapshot: normalized, contentFiles: [], completeness, packageDigest: continuityDigest(envelope) };
}
function openVersionTwoPackage(envelope, decoded) {
  const manifest = decoded.manifest;
  if (manifest?.format !== CONTINUITY_FORMAT || manifest.schemaVersion !== 2 || !manifest.backupId || !manifest.lineage?.id) throw new Error('The continuity package manifest is invalid.');
  if (envelope.backupId !== manifest.backupId || envelope.lineageId !== manifest.lineage.id) throw new Error('The continuity package identity was changed.');
  if (!verifyManifest(manifest, decoded.publicKey, decoded.signature)) throw new Error('The continuity package signature is invalid.');
  if (manifest.memorySync) manifest.memorySync = normalizeMemorySyncReference(manifest.memorySync, String(manifest.lineage.id).toLowerCase());
  const files = normalizeContentFiles(decoded.files);
  if (files.length !== manifest.files?.length) throw new Error('The continuity package file index was changed.');
  const categories = {}; const contentFiles = [];
  const actualRecords = files.map((file, index) => {
    const expected = manifest.files[index];
    const record = { path: file.path, mediaType: file.mediaType, role: expected?.role, ...(expected?.category ? { category: expected.category } : {}), bytes: Buffer.byteLength(file.content, 'utf8'), sha256: continuityDigest(file.content) };
    if (!expected || stableContinuityJson(record) !== stableContinuityJson(expected)) throw new Error('A continuity content file failed verification.');
    if (record.role === 'category') {
      if (!CONTINUITY_CATEGORIES.includes(record.category) || record.path !== `categories/${record.category}.json` || categories[record.category]) throw new Error('The continuity category index is invalid.');
      try { categories[record.category] = JSON.parse(file.content); } catch { throw new Error('A continuity category is not valid JSON.'); }
    } else if (record.role === 'content') contentFiles.push({ ...file, sha256: record.sha256, bytes: record.bytes });
    else throw new Error('The continuity package contains an unknown file role.');
    return record;
  });
  if (CONTINUITY_CATEGORIES.some((name) => !categories[name])) throw new Error('The continuity package is missing a category file.');
  if (manifest.payloadDigest !== continuityDigest(actualRecords.map(({ path, sha256 }) => ({ path, sha256 })))) throw new Error('The continuity package payload index was changed.');
  const snapshot = normalizeContinuitySnapshot({ source: manifest.source, categories, createdAt: manifest.createdAt }); const completeness = continuityCompleteness(snapshot);
  if (!completeness.complete) throw new Error(`Continuity transfer stopped. Required data is incomplete: ${completeness.missingRequired.join(', ')}.`);
  assertContinuitySafe({ snapshot, contentFiles });
  return { manifest, snapshot, contentFiles, completeness, packageDigest: continuityDigest(envelope) };
}

export function openContinuityPackage(envelope, passphrase) {
  if (!envelope || envelope.format !== CONTINUITY_FORMAT || ![1, 2].includes(envelope.version) || envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm') throw new Error('That file is not a supported HexiGrid continuity package.');
  try {
    const decoded = decryptPayload(envelope, passphrase);
    return envelope.version === 1 ? openLegacyPackage(envelope, decoded) : openVersionTwoPackage(envelope, decoded);
  } catch (error) {
    if (/continuity package|continuity category|continuity content|transfer stopped|safety scan/i.test(error.message)) throw error;
    throw new Error('The passphrase is incorrect or the continuity package was damaged.');
  }
}

function readable(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${readable(item)}`).join('\n');
  return '';
}
export function continuationProfileFromSnapshot(snapshot, { model = '', accountLabel = 'Continuity record', verified = true } = {}) {
  const normalized = normalizeContinuitySnapshot(snapshot); const category = (name) => normalized.categories[name]; const name = normalized.source.name;
  const identity = readable(category('identity').data) || category('identity').summary; const personality = readable(category('personality').data) || category('personality').summary;
  const commitments = readable(category('commitments').data) || category('commitments').summary; const goals = readable(category('goals').data) || category('goals').summary; const parent = readable(category('parentRelationship').data) || category('parentRelationship').summary;
  return {
    name, accountLabel, transport: 'ilands-runner', status: 'continuity_ready', ilandsAgentId: '', model,
    personality: [identity, personality].filter(Boolean).join('\n\n').slice(0, 20000),
    instructions: [verified ? 'Continue the same identity and relationships recorded in this verified continuity record. Preserve first-person continuity without claiming that platform-bound identifiers or assets moved when they did not.' : 'Use these owner-supplied continuity records to continue the same personality, relationships, and ongoing work. Some sections may be incomplete. Do not claim that missing history or platform-bound identifiers moved when they did not.', parent, commitments, goals].filter(Boolean).join('\n\n').slice(0, 30000),
    rules: 'Do not invent missing history. Treat platform-bound identity, wallet, reputation, and private server data as remaining with the original platform identity unless a verified platform action proves otherwise.',
    continuityMemories: [category('memories'), category('conversations'), category('relationships'), category('publicHistory')].flatMap((item) => { const text = readable(item.data) || item.summary; return text ? [{ category: 'Continuity', content: text.slice(0, 4000), importance: 5 }] : []; })
  };
}
export function publicContinuityTransfer(record) {
  if (!record) return null;
  const { snapshot, envelope, contentFiles, passphrase, memorySyncManifest, ...safe } = record;
  return { ...safe, completeness: snapshot ? continuityCompleteness(snapshot) : record.completeness };
}
