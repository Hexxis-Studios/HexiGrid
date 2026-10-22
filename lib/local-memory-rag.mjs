import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createLocalEmbeddingRuntime } from './local-embeddings.mjs';
import { openLocalRagIndex } from './local-rag-index.mjs';

const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;

function lineageDatabase(root, lineageId) {
  const selected = String(lineageId || '').toLowerCase();
  if (!LINEAGE_ID.test(selected)) throw new Error('Memory retrieval requires a valid continuity lineage.');
  const base = path.resolve(root);
  const target = path.resolve(base, `${selected}.sqlite`);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('Memory index path escaped its private root.');
  return target;
}

function lexicalWords(value) {
  return String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function lexicalRelevance(query, text) {
  const queryWords = new Set(lexicalWords(query));
  if (!queryWords.size) return 0;
  const factWords = new Set(lexicalWords(text));
  let matched = 0;
  for (const word of queryWords) if (factWords.has(word)) matched += 1;
  return matched / queryWords.size;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_K3 = 8;

function termFrequencies(words) {
  const frequencies = new Map();
  for (const word of words) frequencies.set(word, (frequencies.get(word) || 0) + 1);
  return frequencies;
}

/** Rank only the canonical, already-authorized candidate corpus supplied by the caller. */
function lexicalBm25(query, records) {
  const queryFrequencies = termFrequencies(lexicalWords(query));
  const ranked = new Map();
  if (!queryFrequencies.size || !records.length) return ranked;

  const queryTerms = new Set(queryFrequencies.keys());
  const documentFrequency = new Map([...queryTerms].map((word) => [word, 0]));
  const documents = records.map((record) => {
    const words = lexicalWords(record.text);
    const frequencies = new Map();
    for (const word of words) if (queryTerms.has(word)) {
      frequencies.set(word, (frequencies.get(word) || 0) + 1);
    }
    for (const word of frequencies.keys()) documentFrequency.set(word, documentFrequency.get(word) + 1);
    return { record, frequencies, length: words.length };
  });
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length;
  const inverseDocumentFrequency = new Map();
  for (const [word, queryFrequency] of queryFrequencies) {
    const frequency = documentFrequency.get(word) || 0;
    const idf = Math.log1p((documents.length - frequency + 0.5) / (frequency + 0.5));
    const queryWeight = ((BM25_K3 + 1) * queryFrequency) / (BM25_K3 + queryFrequency);
    inverseDocumentFrequency.set(word, { idf, queryWeight });
  }

  const rawScores = [];
  let highestRawScore = 0;
  for (const document of documents) {
    let rawScore = 0;
    for (const [word, frequency] of document.frequencies) {
      const term = inverseDocumentFrequency.get(word);
      if (!term) continue;
      const { idf, queryWeight } = term;
      const lengthNorm = averageLength > 0 ? 1 - BM25_B + BM25_B * document.length / averageLength : 1;
      const termFrequencyWeight = (frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * lengthNorm);
      rawScore += idf * termFrequencyWeight * queryWeight;
    }
    rawScores.push({ document, rawScore });
    highestRawScore = Math.max(highestRawScore, rawScore);
  }
  if (!(highestRawScore > 0)) return ranked;
  // Normalize against the strongest result in this bounded candidate corpus.
  // This keeps the best candidate at 1 (including one-document cold starts)
  // while BM25's TF, DF, query-frequency and length terms set the ranking.
  for (const { document, rawScore } of rawScores) ranked.set(document.record.id, {
    score: Math.max(0, Math.min(1, rawScore / highestRawScore)),
    rawScore,
    coverage: lexicalRelevance(query, document.record.text)
  });
  return ranked;
}

function isCurrentValidRecord(record, nowMs = Date.now()) {
  if (!record || !['active', 'conditional'].includes(record.status)) return false;
  if (typeof record.valid_from === 'string' && (!Number.isFinite(Date.parse(record.valid_from)) || Date.parse(record.valid_from) > nowMs)) return false;
  if (typeof record.valid_until === 'string' && (!Number.isFinite(Date.parse(record.valid_until)) || Date.parse(record.valid_until) <= nowMs)) return false;
  return true;
}

export class LocalMemoryRag {
  #root;
  #store;
  #runtimeFactory;
  #runtimePromise = null;
  #indexes = new Map();

  constructor({ root, store, runtimeFactory = createLocalEmbeddingRuntime }) {
    if (!path.isAbsolute(String(root || '')) || !store?.readRange) throw new Error('Local memory retrieval requires private index storage and a dated-memory store.');
    this.#root = path.resolve(root);
    this.#store = store;
    this.#runtimeFactory = runtimeFactory;
  }

  async #runtime() {
    this.#runtimePromise ||= Promise.resolve().then(() => this.#runtimeFactory()).catch((error) => {
      this.#runtimePromise = null;
      throw error;
    });
    return this.#runtimePromise;
  }

  async #index(lineageId) {
    const databasePath = lineageDatabase(this.#root, lineageId);
    if (!this.#indexes.has(databasePath)) {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      this.#indexes.set(databasePath, await openLocalRagIndex(databasePath));
    }
    return this.#indexes.get(databasePath);
  }

  async indexRange({ lineageId, from, to }) {
    const entries = await this.#store.recall({ lineageId, from, to });
    if (!entries.length) return { indexed: 0, total: (await this.#index(lineageId)).count() };
    const runtime = await this.#runtime();
    const index = await this.#index(lineageId);
    const batchSize = 32;
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      const batch = entries.slice(offset, offset + batchSize);
      const embeddings = await runtime.embedDocuments(batch.map((entry) => entry.text));
      index.insertMany(batch.map((entry, position) => ({
        id: entry.chunkId,
        sourceFile: entry.sourceFile,
        sourceDate: entry.date,
        chunkIndex: entry.chunkIndex,
        text: entry.text,
        embedding: embeddings[position]
      })));
    }
    index.checkpoint();
    return { indexed: entries.length, total: index.count() };
  }

  async hardDelete({ lineageId, id }) {
    const index = await this.#index(lineageId);
    index.remove(id);
    index.checkpoint();
  }

  async semanticSearch({ lineageId, query, limit = 5, depth = 0 }) {
    const cleanQuery = String(query ?? '').trim();
    if (!cleanQuery || Buffer.byteLength(cleanQuery, 'utf8') > 16 * 1024) throw new Error('Memory search requires a bounded non-empty query.');
    if (![0, 1, 2].includes(depth)) throw new Error('Memory recall depth must be 0, 1, or 2.');
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 5));
    // Canonical records are authoritative even when the derived index is old.
    // Both search entry points use the same ranker; no short-query exception.
    // ponytail: lineage-wide canonical scan; add a revision-aware candidate index
    // when measured store size makes this cost material, preserving fresh facts.
    const records = await this.#store.readRange({ lineageId, from: '0001-01-01', to: '9999-12-31', depth });
    const nowMs = Date.now();
    const current = records.filter(record => isCurrentValidRecord(record, nowMs));
    const scores = await this.scoreCandidates({ lineageId, query: cleanQuery, records: current });
    return current.map(record => ({ record, match: scores.get(record.id) }))
      .filter(({ match }) => match.score > 0)
      .sort((left, right) => right.match.score - left.match.score ||
        String(right.record.updatedAt || right.record.createdAt || '').localeCompare(String(left.record.updatedAt || left.record.createdAt || '')) ||
        Number(right.record.importance || 0) - Number(left.record.importance || 0) || left.record.id.localeCompare(right.record.id))
      .slice(0, boundedLimit)
      .map(({ record, match }) => ({ ...record, score: match.confidence,
        rankScore: match.score, bm25Score: match.bm25Score, matchMethod: match.method }));
  }

  async scoreCandidates({ lineageId, query, records }) {
    const cleanQuery = String(query ?? '').trim();
    if (!cleanQuery || Buffer.byteLength(cleanQuery, 'utf8') > 16 * 1024) throw new Error('Memory search requires a bounded non-empty query.');
    if (!Array.isArray(records)) throw new Error('Memory context records are invalid.');
    if (!records.length) return new Map();
    // The canonical scope has already been filtered before this ranking step.
    // Reuse current local vectors; missing or stale vectors take a cheap lexical
    // path so a large scope is never re-embedded for every signed message.
    const semanticScores = new Map();
    const lexicalScores = lexicalBm25(cleanQuery, records);
    try {
      const index = await this.#index(lineageId);
      // A purely lexical request over an empty index needs no embedding runtime.
      if (index.count() > 0) {
        const runtime = await this.#runtime();
        const [queryVector] = await runtime.embedQueries(cleanQuery);
        for (const [id, score] of index.scoresForRecords(queryVector, records)) {
          if (Number.isFinite(score)) semanticScores.set(id, Math.max(0, Math.min(1, score)));
        }
      }
    } catch {
      // A missing local model or derived index must not suppress authorized
      // current facts. No remote service is contacted.
    }
    const scores = new Map();
    for (const record of records) {
      const lexical = lexicalScores.get(record.id);
      const bm25Score = lexical?.score || 0;
      const coverage = lexical?.coverage || 0;
      const semantic = semanticScores.get(record.id);
      scores.set(record.id, semantic === undefined
        ? { score: bm25Score, method: 'lexical-fallback', bm25Score, confidence: coverage }
        : { score: (semantic + bm25Score) / 2, method: 'hybrid', bm25Score,
          // Rank normalization is corpus-relative; it is not confidence.
          // Confidence describes the strongest relevance signal, never truth.
          confidence: Math.max(semantic, coverage) });
    }
    return scores;
  }

  async checkpoint() {
    for (const index of this.#indexes.values()) index.checkpoint();
  }

  async close() {
    for (const index of this.#indexes.values()) index.close();
    this.#indexes.clear();
    if (this.#runtimePromise) await (await this.#runtimePromise.catch(() => null))?.dispose();
    this.#runtimePromise = null;
  }
}
