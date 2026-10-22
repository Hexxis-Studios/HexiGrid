import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MANIFEST_PATH = new URL('../config/local-embedding-model.json', import.meta.url);

function assertSafeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    throw new Error(`Unsafe model file path: ${value}`);
  }
  return normalized;
}

export async function readLocalEmbeddingManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('The local embedding manifest is invalid.');
  }
  for (const file of manifest.files) {
    assertSafeRelativePath(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1) {
      throw new Error(`The manifest entry for ${file.path} is invalid.`);
    }
  }
  return manifest;
}

export function defaultLocalModelRoot(env = process.env) {
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  return localAppData ? path.join(localAppData, 'HexiGrid', 'models') : path.join(homedir(), '.hexigrid', 'models');
}

export function modelInstallDirectory(manifest, modelRoot = defaultLocalModelRoot()) {
  const segments = String(manifest.modelId || '').split('/').map((segment) => segment.trim());
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error('The local embedding model ID is invalid.');
  }
  if (!/^[a-f0-9]{40}$/.test(String(manifest.revision || ''))) throw new Error('The local embedding revision is invalid.');
  return path.join(modelRoot, manifest.revision, ...segments);
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

export async function verifyLocalEmbeddingInstall({ manifest, modelRoot = defaultLocalModelRoot() } = {}) {
  const selectedManifest = manifest || await readLocalEmbeddingManifest();
  const modelDir = modelInstallDirectory(selectedManifest, modelRoot);
  const results = [];
  for (const entry of selectedManifest.files) {
    const relativePath = assertSafeRelativePath(entry.path);
    const filePath = path.join(modelDir, ...relativePath.split('/'));
    try {
      await access(filePath);
      const details = await lstat(filePath);
      const regularFile = details.isFile() && !details.isSymbolicLink();
      const hash = regularFile && details.size === entry.bytes ? await sha256File(filePath) : '';
      results.push({ path: relativePath, ok: regularFile && details.size === entry.bytes && hash === entry.sha256, bytes: details.size, sha256: hash });
    } catch {
      results.push({ path: relativePath, ok: false, bytes: 0, sha256: '' });
    }
  }
  return { ok: results.every((result) => result.ok), modelDir, results };
}

function toRows(tensor) {
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  if (dims.length !== 2 || !ArrayBuffer.isView(tensor.data)) throw new Error('The embedding model returned an invalid tensor.');
  const [count, dimensions] = dims;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(Float32Array.from(tensor.data.subarray(index * dimensions, (index + 1) * dimensions)));
  }
  return rows;
}

export async function createLocalEmbeddingRuntime({ modelRoot = defaultLocalModelRoot(), transformers } = {}) {
  const manifest = await readLocalEmbeddingManifest();
  const verified = await verifyLocalEmbeddingInstall({ manifest, modelRoot });
  if (!verified.ok) {
    const missing = verified.results.filter((result) => !result.ok).map((result) => result.path).join(', ');
    throw new Error(`The pinned local embedding model is missing or failed verification: ${missing}. Run npm run model:install-embeddings.`);
  }

  const library = transformers || await import('@huggingface/transformers');
  library.env.allowRemoteModels = false;
  library.env.allowLocalModels = true;
  const extractor = await library.pipeline('feature-extraction', verified.modelDir, {
    dtype: manifest.dtype,
    local_files_only: true
  });

  async function embed(texts, { query = false } = {}) {
    const input = (Array.isArray(texts) ? texts : [texts]).map((value) => {
      const text = String(value ?? '').trim();
      if (!text) throw new Error('Embedding text cannot be empty.');
      return query ? `${manifest.queryPrefix}${text}` : text;
    });
    const tensor = await extractor(input, { pooling: manifest.pooling, normalize: true });
    const rows = toRows(tensor);
    if (rows.some((row) => row.length !== manifest.embeddingDimensions)) {
      throw new Error('The embedding model returned an unexpected vector size.');
    }
    return rows;
  }

  return {
    manifest,
    modelDir: verified.modelDir,
    embedDocuments: (texts) => embed(texts),
    embedQueries: (texts) => embed(texts, { query: true }),
    dispose: () => extractor.dispose()
  };
}
