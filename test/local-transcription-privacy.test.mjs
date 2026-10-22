import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalTranscriber } from '../lib/local-transcription.mjs';

test('transcription startup removes only abandoned call-temp directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-transcription-test-'));
  const tempRoot = path.join(root, 'call-temp');
  try {
    await fs.mkdir(path.join(tempRoot, 'segment-stale'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'segment-stale', 'speech.wav'), 'synthetic-test-audio');
    await fs.mkdir(path.join(tempRoot, 'unrelated'), { recursive: true });
    const transcriber = new LocalTranscriber({ root });
    await transcriber.prepare();
    await assert.rejects(() => fs.stat(path.join(tempRoot, 'segment-stale')), { code: 'ENOENT' });
    assert.ok((await fs.stat(path.join(tempRoot, 'unrelated'))).isDirectory());
    if (process.platform !== 'win32') assert.equal((await fs.stat(tempRoot)).mode & 0o077, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
