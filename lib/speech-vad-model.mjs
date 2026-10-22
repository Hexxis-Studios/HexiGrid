import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Upstream ggml-org/whisper-vad, Silero v5.1.2 (MIT). Download weights
// only; microphone audio never leaves the machine. See THIRD-PARTY-NOTICES.
export const SPEECH_VAD_MODEL = Object.freeze({
  filename: 'ggml-silero-v5.1.2.bin', bytes: 885098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin'
});

function verified(bytes) {
  return bytes.length === SPEECH_VAD_MODEL.bytes && createHash('sha256').update(bytes).digest('hex') === SPEECH_VAD_MODEL.sha256;
}

export async function ensureSpeechVadModel(modelRoot, { fetchModel = fetch } = {}) {
  const target = path.join(modelRoot, 'models', SPEECH_VAD_MODEL.filename);
  try {
    const bytes = await fs.readFile(target);
    if (!verified(bytes)) throw new Error('The local speech detector failed integrity verification.');
    return target;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchModel(SPEECH_VAD_MODEL.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error('The local speech detector could not be prepared. Connect once to download its free model.');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > SPEECH_VAD_MODEL.bytes) throw new Error('The speech detector download exceeded its expected size.');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!verified(bytes)) throw new Error('The speech detector download failed integrity verification.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.pending`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return target;
}
