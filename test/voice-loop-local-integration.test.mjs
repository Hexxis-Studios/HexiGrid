import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalTranscriber } from '../lib/local-transcription.mjs';
import { synthesizeLocalSpeech } from '../lib/local-tts.mjs';
import { readDesktopSpeaker, resetDesktopMediaForTests, startDesktopMedia } from '../lib/desktop-media.mjs';
import { answerVoiceCall, resetVoiceCallForTests, startVoiceCall } from '../lib/voice-call.mjs';
import { publishVoiceReply } from '../lib/voice-reply.mjs';
import { VoiceAgentRuntime } from '../lib/voice-agent-runtime.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelRoot = path.join(projectRoot, 'data', 'transcription');
const installed = process.platform === 'win32' && await fs.access(path.join(modelRoot, 'models', 'ggml-tiny.bin')).then(() => true, () => false);

test('installed local speech completes a turn during continuous chunks and the agent runtime queues local audio', { skip: !installed, timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-voice-loop-test-'));
  resetVoiceCallForTests(); resetDesktopMediaForTests();
  let quietTimer, runtime;
  try {
    const transcriber = new LocalTranscriber({ root, modelRoot });
    const input = await synthesizeLocalSpeech('Hello ExampleAgent. Can you hear me?');
    const quiet = Buffer.from(input.bytes);
    let silenced = false;
    for (let offset = 12; offset + 8 <= quiet.length;) {
      const size = quiet.readUInt32LE(offset + 4), next = offset + 8 + size;
      assert.ok(next <= quiet.length);
      if (quiet.toString('ascii', offset, offset + 4) === 'data') { quiet.fill(0, offset + 8, next); silenced = true; break; }
      offset = next + (size % 2);
    }
    assert.equal(silenced, true, 'synthetic silence retains its valid WAV container');
    const started = performance.now();
    startDesktopMedia({ linkId: 'link-local-loop', microphoneGranted: true, speakerGranted: true });
    startVoiceCall({ linkId: 'link-local-loop', microphoneGranted: true, speakerGranted: true });
    answerVoiceCall('link-local-loop');
    const client = new EventTarget(), events = [];
    client.linkRequest = async (pathname, options) => ({ ok: true, body: await publishVoiceReply('link-local-loop', options.body.text) });
    let resolveReply, rejectReply;
    const completed = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    runtime = new VoiceAgentRuntime({ client,
      // The production agent supplies cognition; this harmless fixed callback tests only its boundary.
      respond: async ({ transcript }) => { assert.match(transcript.toLowerCase(), /hello|exampleagent|hear/); return 'Yes, I can hear you.'; },
      onResult: result => { if (result.type === 'reply-ready' || result.type === 'reply-queued') resolveReply(result); if (result.type === 'error') rejectReply(new Error(result.reason)); }
    });
    runtime.callId = 'synthetic-local-loop';
    const connection = { id: 'link-local-loop', transcription: { enabled: true, model: 'tiny', language: 'en' } };
    const emit = event => {
      const callEvent = { ...event, metadata: { ...event.metadata, callId: runtime.callId, mediaEpoch: runtime.mediaEpoch } };
      events.push(callEvent); client.dispatchEvent(new CustomEvent('event', { detail: callEvent }));
    };
    transcriber.enqueue(connection, { mimeType: 'audio/wav', data: input.bytes.toString('base64'), sequence: 1, speechActive: true }, emit);
    let sequence = 1;
    quietTimer = setInterval(() => transcriber.enqueue(connection, { mimeType: 'audio/wav', data: quiet.toString('base64'), sequence: ++sequence, speechActive: false }, emit), 500);
    const result = await completed;
    clearInterval(quietTimer); transcriber.clear(connection.id);
    assert.ok(sequence >= 3, 'capture chunks continued while the final turn completed');
    assert.equal(events.filter(event => event.type === 'speech.transcript.final').length, 1);
    assert.equal(result.segments, 1);
    const playback = readDesktopSpeaker('link-local-loop').speaker;
    assert.equal(playback.length, 1);
    assert.equal(playback[0].mimeType, 'audio/wav');
    assert.equal(Buffer.from(playback[0].data, 'base64').subarray(0, 4).toString(), 'RIFF');
    t.diagnostic(`Synthetic continuous chunks → local STT final event → bundled agent runtime/fixed cognition → local TTS: ${(performance.now() - started).toFixed(1)} ms. No physical capture/playback, remote transport or model cognition.`);
    assert.deepEqual(await fs.readdir(path.join(root, 'call-temp')), []);
  } finally {
    clearInterval(quietTimer); runtime?.close();
    resetVoiceCallForTests(); resetDesktopMediaForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});
