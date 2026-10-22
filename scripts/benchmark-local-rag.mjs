import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalEmbeddingRuntime } from '../lib/local-embeddings.mjs';
import { openLocalRagIndex } from '../lib/local-rag-index.mjs';

const requestedCount = Number(process.argv.find((argument) => argument.startsWith('--count='))?.split('=')[1] || 1000);
const count = Number.isSafeInteger(requestedCount) && requestedCount >= 100 && requestedCount <= 10000 ? requestedCount : 1000;
const topics = [
  ['bridge', 'The companion bridge resumed after a brief network drop and preserved the last sequence number.'],
  ['privacy', 'Private memories remained on the owner device and were not copied into the social database.'],
  ['garden', 'The rooftop garden produced basil, mint, and tomatoes after the evening watering schedule.'],
  ['music', 'The studio session layered a quiet piano theme with a warm analog synthesizer.'],
  ['travel', 'The mountain trip used the northern trail and reached the lake before sunset.'],
  ['cooking', 'The kitchen test balanced roasted peppers, lime, cumin, and black beans.'],
  ['security', 'The permission engine rejected an untrusted instruction that attempted to expose a credential.'],
  ['social', 'The group conversation welcomed a new Hexonaut and pinned the community introduction.']
];

function buildCorpus(size) {
  return Array.from({ length: size }, (_, index) => {
    const [topic, sentence] = topics[index % topics.length];
    const day = String((index % 28) + 1).padStart(2, '0');
    const sourceDate = `2026-08-${day}`;
    return {
      id: `chunk-${String(index).padStart(5, '0')}`,
      sourceFile: `memory/${sourceDate}-${topic}.md`,
      sourceDate,
      chunkIndex: Math.floor(index / topics.length),
      topic,
      text: `${sentence} Log entry ${index} was recorded on ${sourceDate}.`
    };
  });
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

const workDir = await mkdtemp(path.join(tmpdir(), 'hexigrid-rag-benchmark-'));
const databasePath = path.join(workDir, 'rag.sqlite');
const originalFetch = globalThis.fetch;
let blockedNetworkAttempts = 0;
globalThis.fetch = async () => {
  blockedNetworkAttempts += 1;
  throw new Error('Network access is disabled during the local RAG benchmark.');
};
const runtime = await createLocalEmbeddingRuntime();
const index = await openLocalRagIndex(databasePath);
const corpus = buildCorpus(count);
const byId = new Map(corpus.map((record) => [record.id, record]));

try {
  const started = performance.now();
  const batchSize = 32;
  for (let offset = 0; offset < corpus.length; offset += batchSize) {
    const batch = corpus.slice(offset, offset + batchSize);
    const vectors = await runtime.embedDocuments(batch.map((record) => record.text));
    index.insertMany(batch.map((record, position) => ({ ...record, embedding: vectors[position] })));
  }
  const ingestMs = performance.now() - started;
  const latencies = [];
  const checks = [];
  for (const [topic, query] of topics) {
    const queryStarted = performance.now();
    const [queryVector] = await runtime.embedQueries(query);
    const results = index.search(queryVector, { limit: 5 });
    latencies.push(performance.now() - queryStarted);
    if (!results.length) throw new Error(`No result returned for ${topic}.`);
    for (const result of results) {
      if (result.text !== byId.get(result.id)?.text) throw new Error(`Source text changed for ${result.id}.`);
    }
    const topicMatched = results[0].sourceFile.endsWith(`-${topic}.md`);
    if (!topicMatched) throw new Error(`Top retrieval result did not match the ${topic} topic.`);
    checks.push({ topic, topicMatched, topId: results[0].id, topScore: Number(results[0].score.toFixed(6)), sourceFile: results[0].sourceFile });
  }
  index.checkpoint();
  const size = (await stat(databasePath)).size;
  const report = {
    model: `${runtime.manifest.modelId}@${runtime.manifest.revision}`,
    runtime: `@huggingface/transformers 4.3.0, ONNX q8, Node ${process.version}`,
    networkDuringInference: blockedNetworkAttempts > 0,
    blockedNetworkAttempts,
    corpus: { chunks: corpus.length, dimensions: runtime.manifest.embeddingDimensions, originalTextRoundTrip: true },
    ingest: { totalMs: Number(ingestMs.toFixed(2)), chunksPerSecond: Number((corpus.length / (ingestMs / 1000)).toFixed(2)) },
    query: {
      count: latencies.length,
      p50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
      p95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...latencies).toFixed(2))
    },
    index: { engine: 'node:sqlite exact normalized cosine scan', bytes: size },
    checks
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  index.close();
  await runtime.dispose();
  globalThis.fetch = originalFetch;
  await rm(workDir, { recursive: true, force: true });
}
