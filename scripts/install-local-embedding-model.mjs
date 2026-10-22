import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import {
  defaultLocalModelRoot,
  modelInstallDirectory,
  readLocalEmbeddingManifest,
  verifyLocalEmbeddingInstall
} from '../lib/local-embeddings.mjs';

const manifest = await readLocalEmbeddingManifest();
const modelRoot = process.env.HEXIGRID_MODEL_ROOT || defaultLocalModelRoot();
const modelDir = modelInstallDirectory(manifest, modelRoot);
const notice = [
  `${manifest.modelId}@${manifest.revision}`,
  '',
  'Licensed under the Apache License, Version 2.0.',
  'https://www.apache.org/licenses/LICENSE-2.0',
  '',
  `Pinned source: ${manifest.sourceBaseUrl}`,
  'Artifact byte counts and SHA-256 digests are recorded in HexiGrid config/local-embedding-model.json.',
  'HexiGrid does not automatically update this model.',
  ''
].join('\n');

async function download(entry) {
  const target = path.join(modelDir, ...entry.path.split('/'));
  const partial = `${target}.part`;
  await mkdir(path.dirname(target), { recursive: true });
  await rm(partial, { force: true });
  const url = `${manifest.sourceBaseUrl}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'HexiGrid-local-model-installer/1' } });
  if (!response.ok || !response.body) throw new Error(`Download failed for ${entry.path}: HTTP ${response.status}.`);
  const hash = createHash('sha256');
  let bytes = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
  });
  try {
    await streamPipeline(source, createWriteStream(partial, { flags: 'wx' }));
    const digest = hash.digest('hex');
    if (bytes !== entry.bytes || digest !== entry.sha256) {
      throw new Error(`Hash verification failed for ${entry.path}; expected ${entry.sha256}, received ${digest}.`);
    }
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  process.stdout.write(`Verified ${entry.path} (${bytes} bytes)\n`);
}

for (const entry of manifest.files) {
  const target = path.join(modelDir, ...entry.path.split('/'));
  try {
    const details = await stat(target);
    if (details.size === entry.bytes) {
      const verification = await verifyLocalEmbeddingInstall({ manifest: { ...manifest, files: [entry] }, modelRoot });
      if (verification.ok) {
        process.stdout.write(`Already verified ${entry.path}\n`);
        continue;
      }
    }
    throw new Error(`Existing model file failed verification: ${target}. Remove that exact file before retrying.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await download(entry);
}

const verified = await verifyLocalEmbeddingInstall({ manifest, modelRoot });
if (!verified.ok) throw new Error('The completed model install did not pass final verification.');
await writeFile(path.join(modelDir, 'HEXIGRID-MODEL-NOTICE.txt'), notice, { encoding: 'utf8', flag: 'w' });
process.stdout.write(`Pinned ${manifest.modelId}@${manifest.revision} is ready at ${verified.modelDir}\n`);
