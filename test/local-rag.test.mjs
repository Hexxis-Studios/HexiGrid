import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  modelInstallDirectory,
  readLocalEmbeddingManifest,
  sha256File,
  verifyLocalEmbeddingInstall
} from '../lib/local-embeddings.mjs';
import { cosineForNormalizedVectors, openLocalRagIndex } from '../lib/local-rag-index.mjs';

test('local embedding manifest pins immutable model files and safe paths', async () => {
  const manifest = await readLocalEmbeddingManifest();
  assert.equal(manifest.modelId, 'Snowflake/snowflake-arctic-embed-s');
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.embeddingDimensions, 384);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(manifest.files.some((file) => file.path === 'onnx/model_quantized.onnx'));
});

test('model verification rejects missing and modified files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-model-verify-'));
  const manifest = {
    modelId: 'Vendor/Model',
    revision: 'a'.repeat(40),
    files: [{ path: 'config.json', bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }]
  };
  try {
    assert.equal((await verifyLocalEmbeddingInstall({ manifest, modelRoot: root })).ok, false);
    const directory = modelInstallDirectory(manifest, root);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'config.json'), 'hello');
    assert.equal(await sha256File(path.join(directory, 'config.json')), manifest.files[0].sha256);
    assert.equal((await verifyLocalEmbeddingInstall({ manifest, modelRoot: root })).ok, true);
    await writeFile(path.join(directory, 'config.json'), 'other');
    assert.equal((await verifyLocalEmbeddingInstall({ manifest, modelRoot: root })).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite exact cosine index preserves source text and metadata byte-for-byte', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-rag-index-'));
  const index = await openLocalRagIndex(path.join(root, 'index.sqlite'));
  try {
    index.insertMany([
      { id: 'one', sourceFile: 'memory/one.md', sourceDate: '2026-09-20', chunkIndex: 0, text: 'Original α text\nwith newline.', embedding: new Float32Array([1, 0, 0]) },
      { id: 'two', sourceFile: 'memory/two.md', sourceDate: '2026-09-21', chunkIndex: 4, text: 'Different text.', embedding: new Float32Array([0, 1, 0]) }
    ]);
    const [result] = index.search(new Float32Array([0.99, 0.01, 0]), { limit: 1 });
    assert.equal(result.id, 'one');
    assert.equal(result.text, 'Original α text\nwith newline.');
    assert.equal(result.sourceFile, 'memory/one.md');
    assert.equal(result.sourceDate, '2026-09-20');
    assert.equal(result.chunkIndex, 0);
    assert.equal(index.count(), 2);
    assert.ok(cosineForNormalizedVectors(new Float32Array([1, 0]), new Float32Array([1, 0])) > 0.999);
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
