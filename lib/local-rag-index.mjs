import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function vectorToBuffer(vector) {
  if (!(vector instanceof Float32Array)) throw new TypeError('Embeddings must be Float32Array values.');
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToVector(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('Stored embedding length is invalid.');
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer);
}

export function cosineForNormalizedVectors(left, right) {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length) {
    throw new Error('Vectors must be equally sized Float32Array values.');
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

export async function openLocalRagIndex(databasePath) {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  let insert, selectAll, selectById, removeById;
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        source_date TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chunks_source_date ON chunks(source_date, source_file, chunk_index);
    `);
    insert = database.prepare(`
      INSERT INTO chunks (id, source_file, source_date, chunk_index, text, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_file = excluded.source_file,
        source_date = excluded.source_date,
        chunk_index = excluded.chunk_index,
        text = excluded.text,
        embedding = excluded.embedding
    `);
    selectAll = database.prepare('SELECT id, source_file, source_date, chunk_index, text, embedding FROM chunks');
    selectById = database.prepare('SELECT text, embedding FROM chunks WHERE id = ?');
    removeById = database.prepare('DELETE FROM chunks WHERE id = ?');
  } catch (error) {
    // Failed derived-index initialization must not retain a Windows file lock.
    try { database.close(); } catch {}
    throw error;
  }

  return {
    insertMany(records) {
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const record of records) {
          insert.run(record.id, record.sourceFile, record.sourceDate, record.chunkIndex, record.text, vectorToBuffer(record.embedding));
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    remove(id) { removeById.run(String(id)); },
    search(queryVector, { limit = 5 } = {}) {
      const boundedLimit = Math.max(1, Math.min(100000, Number(limit) || 5));
      return selectAll.all()
        .map((row) => ({
          id: row.id,
          sourceFile: row.source_file,
          sourceDate: row.source_date,
          chunkIndex: row.chunk_index,
          text: row.text,
          score: cosineForNormalizedVectors(queryVector, bufferToVector(row.embedding))
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, boundedLimit);
    },
    searchLexical(query, { limit = 5 } = {}) {
      const words = (value) => new Set(String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      const queryWords = words(query);
      if (!queryWords.size) return [];
      const boundedLimit = Math.max(1, Math.min(100000, Number(limit) || 5));
      return selectAll.all().map((row) => {
        const factWords = words(row.text);
        let matched = 0;
        for (const word of queryWords) if (factWords.has(word)) matched += 1;
        return { id: row.id, text: row.text, score: matched / queryWords.size };
      }).filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, boundedLimit);
    },
    scoresForRecords(queryVector, records) {
      const scores = new Map();
      for (const record of records) {
        const row = selectById.get(record.id);
        // The canonical log may have revised a fact since its embedding was
        // written. Its old vector must not score the current text.
        if (row?.text === record.text) scores.set(record.id, cosineForNormalizedVectors(queryVector, bufferToVector(row.embedding)));
      }
      return scores;
    },
    count: () => Number(database.prepare('SELECT count(*) AS count FROM chunks').get().count),
    checkpoint: () => database.exec('PRAGMA wal_checkpoint(TRUNCATE);'),
    close: () => database.close()
  };
}
