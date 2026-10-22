import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceAgentRuntime } from '../lib/voice-agent-runtime.mjs';

class FakeClient extends EventTarget {
  constructor() { super(); this.requests = []; }
  async linkRequest(pathname, options) {
    this.requests.push({ pathname, options });
    if (pathname === '/agent-link/v1/voice-call') return { ok: true, body: { voiceCall: { id: 'call-resumed', status: 'active', ownerMuted: false } } };
    return { ok: true, body: pathname.endsWith('/reply') ? { segments: 1 } : { voiceCall: { status: 'active' } } };
  }
  emit(event) { this.dispatchEvent(new CustomEvent('event', { detail: event })); }
}

const transcript = (text, callId, mediaEpoch = 0) => ({ type: 'speech.transcript.final', text,
  metadata: { source: 'owner-microphone', ...(callId ? { callId, mediaEpoch } : {}) } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Expected asynchronous voice turn did not advance.');
}

test('an offered held participant answers but waits, then resumes only fresh speech when selected', async () => {
  const client = new FakeClient(); const received=[];
  const runtime = new VoiceAgentRuntime({client,respond:async({transcript:text})=>{received.push(text);return 'Reply.';}});
  client.emit({type:'voice.call.offered',metadata:{callId:'held',onHold:true}});
  await tick(); client.emit(transcript('Do not hear me.', 'held')); await tick(); assert.deepEqual(received,[]);
  client.emit({type:'voice.call.resumed',metadata:{callId:'held',mediaEpoch:1}});
  client.emit(transcript('Older speech', 'held', 0));
  client.emit(transcript('Selected speech', 'held', 1));
  await tick(); await tick(); assert.deepEqual(received,['Selected speech']);
  client.emit({type:'voice.call.held',metadata:{callId:'held'}}); client.emit(transcript('Private other conversation', 'held', 1)); await tick();
  assert.deepEqual(received,['Selected speech']); runtime.close();
});

test('the answer response reconciles a participant resumed while answer is in flight', async () => {
  const client = new FakeClient(); let resolveAnswer;
  client.linkRequest = (pathname, options) => {
    client.requests.push({ pathname, options });
    return new Promise((resolve) => { resolveAnswer = resolve; });
  };
  const runtime = new VoiceAgentRuntime({ client, respond: async () => 'Ready.' });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'switch-race', mediaEpoch: 0, onHold: true } });
  await waitFor(() => Boolean(resolveAnswer));
  client.emit({ type: 'voice.call.resumed', metadata: { callId: 'switch-race', mediaEpoch: 1 } });
  assert.equal(runtime.onHold, false);
  assert.equal(runtime.mediaEpoch, 1);
  resolveAnswer({ ok: true, body: { voiceCall: { onHold: false, ownerMuted: false, mediaEpoch: 1 } } });
  await tick();
  assert.equal(runtime.onHold, false);
  assert.equal(runtime.muted, false);
  assert.equal(runtime.mediaEpoch, 1);
  runtime.close();
});

test('a transcript from an older call cannot start cognition in a resumed call', async () => {
  const client = new FakeClient(); const received = [];
  const runtime = new VoiceAgentRuntime({ client, respond: async ({ transcript: text }) => { received.push(text); return 'Current reply.'; } });
  await runtime.sync();
  client.emit(transcript('Stale speech.', 'old-call'));
  client.emit(transcript('Unbound speech.'));
  client.emit(transcript('Wrong media selection.', 'call-resumed', 1));
  client.emit(transcript('Current speech.', 'call-resumed'));
  await tick(); await tick();
  assert.deepEqual(received, ['Current speech.']);
  runtime.close();
});

test('the agent runtime answers an offered call, routes a final transcript to cognition, and returns speech', async () => {
  const client = new FakeClient(); const received = []; const results = [];
  const runtime = new VoiceAgentRuntime({ client, respond: async ({ transcript: text }) => { received.push(text); return 'Hello back.'; }, onResult: (item) => results.push(item) });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'call-1' } });
  client.emit({ type: 'speech.transcript.partial', text: 'ignored', metadata: { source: 'owner-microphone' } });
  client.emit(transcript('Hello agent.', 'call-1'));
  await tick(); await tick();
  assert.deepEqual(received, ['Hello agent.']);
  assert.deepEqual(client.requests.map((item) => item.pathname), ['/agent-link/v1/voice-call/answer', '/agent-link/v1/voice-call/reply']);
  assert.deepEqual(client.requests[1].options.body, { text: 'Hello back.', callId: 'call-1', mediaEpoch: 0 });
  assert.equal(results.at(-1).type, 'reply-ready');
  assert.equal(results.at(-1).deliveryStatus, 'text-ready');
  assert.equal(results.at(-1).playbackVerified, false);
  runtime.close();
});

test('final speech transcripts queue in order while the agent is responding', async () => {
  const client = new FakeClient(); const received = []; const results = []; const resolveTurn = [];
  const runtime = new VoiceAgentRuntime({ client,
    respond: ({ transcript: text }) => { received.push(text); return new Promise((resolve) => resolveTurn.push(resolve)); },
    onResult: (result) => results.push(result) });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'call-queue' } });
  await tick();
  client.emit(transcript('First sentence.', 'call-queue'));
  await waitFor(() => received.length === 1);
  client.emit(transcript('Second sentence.', 'call-queue'));
  client.emit(transcript('Third sentence.', 'call-queue'));
  assert.deepEqual(received, ['First sentence.']);
  assert.deepEqual(results.filter((item) => item.type === 'transcript-queued').map((item) => item.pending), [1, 2]);

  resolveTurn[0]('First reply.');
  await waitFor(() => received.length === 2);
  resolveTurn[1]('Second reply.');
  await waitFor(() => received.length === 3);
  resolveTurn[2]('Third reply.');
  await waitFor(() => client.requests.filter((item) => item.pathname.endsWith('/reply')).length === 3);
  assert.deepEqual(client.requests.filter((item) => item.pathname.endsWith('/reply')).map((item) => item.options.body.text),
    ['First reply.', 'Second reply.', 'Third reply.']);
  runtime.close();
});

test('mute drops queued speech and never sends its late reply', async () => {
  const client = new FakeClient(); const received = []; let resolveFirst;
  const runtime = new VoiceAgentRuntime({ client, respond: ({ transcript: text }) => {
    received.push(text);
    return text === 'First sentence.' ? new Promise((resolve) => { resolveFirst = resolve; }) : 'Fresh reply.';
  } });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'call-queue-mute' } });
  await tick();
  client.emit(transcript('First sentence.', 'call-queue-mute'));
  await waitFor(() => Boolean(resolveFirst));
  client.emit(transcript('Private speech while replying.', 'call-queue-mute'));
  client.emit({ type: 'voice.call.muted', metadata: { callId: 'call-queue-mute' } });
  resolveFirst('Must not play.');
  await tick(); await tick();
  assert.deepEqual(received, ['First sentence.']);
  assert.equal(client.requests.some((item) => item.pathname.endsWith('/reply')), false);
  runtime.close();
});

test('an interruption drops older queued speech and accepts the replacement transcript', async () => {
  const client = new FakeClient(); const received = []; const results = []; let resolveFirst;
  const runtime = new VoiceAgentRuntime({ client, respond: ({ transcript: text }) => {
    received.push(text);
    return text === 'First sentence.' ? new Promise((resolve) => { resolveFirst = resolve; }) : `Reply to ${text}`;
  }, onResult: (result) => results.push(result) });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'call-queue-interrupt' } });
  await tick();
  client.emit(transcript('First sentence.', 'call-queue-interrupt'));
  await waitFor(() => Boolean(resolveFirst));
  client.emit(transcript('Older queued sentence.', 'call-queue-interrupt'));
  client.emit({ type: 'voice.call.interrupted', metadata: { callId: 'call-queue-interrupt' } });
  assert.equal(runtime.pendingTranscripts.length, 0);
  resolveFirst('Interrupted reply.');
  await tick();
  client.emit(transcript('Replacement sentence.', 'call-queue-interrupt'));
  await waitFor(() => client.requests.some((item) => item.pathname.endsWith('/reply')));
  assert.deepEqual(received, ['First sentence.', 'Replacement sentence.']);
  assert.deepEqual(client.requests.filter((item) => item.pathname.endsWith('/reply')).map((item) => item.options.body.text),
    ['Reply to Replacement sentence.']);
  assert.equal(results.some((item) => item.type === 'interrupted'), true);
  runtime.close();
});

test('the pending transcript queue is bounded and reports overload explicitly', async () => {
  const client = new FakeClient(); const results = []; let resolveFirst;
  const runtime = new VoiceAgentRuntime({ client,
    respond: () => new Promise((resolve) => { resolveFirst = resolve; }),
    onResult: (result) => results.push(result) });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'call-queue-limit' } });
  await tick();
  client.emit(transcript('Current turn.', 'call-queue-limit'));
  await waitFor(() => Boolean(resolveFirst));
  for (let index = 0; index < 33; index += 1) client.emit(transcript(`Queued ${index}.`, 'call-queue-limit'));
  assert.equal(runtime.pendingTranscripts.length, 32);
  assert.equal(results.filter((item) => item.type === 'transcript-queue-full').length, 1);
  runtime.close();
  resolveFirst('Not delivered after close.');
  await tick();
  assert.equal(client.requests.some((item) => item.pathname.endsWith('/reply')), false);
});

test('a reconnected agent resynchronizes an already active call', async () => {
  const client = new FakeClient();
  const runtime = new VoiceAgentRuntime({ client, respond: async () => 'Back.' });
  assert.equal((await runtime.sync()).id, 'call-resumed');
  client.emit(transcript('You are back.', 'call-resumed'));
  await tick(); await tick();
  assert.equal(client.requests.at(-1).pathname, '/agent-link/v1/voice-call/reply');
  runtime.close();
});

test('mute and end prevent late cognition replies from reaching owner audio', async () => {
  const client = new FakeClient(); let resolveReply;
  const runtime = new VoiceAgentRuntime({ client, respond: () => new Promise((resolve) => { resolveReply = resolve; }) });
  client.emit({ type: 'voice.call.offered', metadata: { callId: 'call-2' } });
  client.emit(transcript('Please wait.', 'call-2'));
  await tick();
  client.emit({ type: 'voice.call.muted' });
  resolveReply('Late reply.');
  await tick();
  assert.equal(client.requests.some((item) => item.pathname.endsWith('/reply')), false);
  client.emit({ type: 'voice.call.unmuted' });
  client.emit(transcript('Again.', 'call-2'));
  await tick();
  client.emit({ type: 'voice.call.ended' });
  resolveReply('Another late reply.');
  await tick();
  assert.equal(client.requests.some((item) => item.pathname.endsWith('/reply')), false);
  runtime.close();
});

test('active call streams owner audio through agent transcription and returns provider voice audio to the speaker queue', async () => {
  const client = new FakeClient(); const events = []; const receivedAudio = []; const transcripts = []; let mediaCalls = 0;
  client.linkRequest = async (pathname, options) => {
    client.requests.push({ pathname, options });
    if (pathname === '/agent-link/v1/voice-call') return { ok: true, body: { voiceCall: { id: 'call-audio', status: 'active', ownerMuted: false } } };
    if (pathname === '/agent-link/v1/voice-call/media') {
      mediaCalls += 1;
      if (mediaCalls === 1) return { ok: true, body: { voiceCall: { id: 'call-audio', status: 'active' }, audio: [{ sequence: 1, mimeType: 'audio/webm', data: Buffer.from('synthetic-owner-speech').toString('base64'), durationMs: 1000, speechActive: true }], replay: { audio: { gap: false } } } };
      if (mediaCalls === 2) return { ok: true, body: { voiceCall: { id: 'call-audio', status: 'active' }, audio: [{ sequence: 2, mimeType: 'audio/webm', data: Buffer.from('synthetic-silence').toString('base64'), durationMs: 1000, speechActive: false }], replay: { audio: { gap: false } } } };
      return { ok: true, body: { voiceCall: { id: 'call-audio', status: 'ended' }, audio: [] } };
    }
    if (pathname.endsWith('/reply')) return { ok: true, body: { segments: 1 } };
    return { ok: true, body: {} };
  };
  let resolveReplied;
  const replied = new Promise((resolve) => { resolveReplied = resolve; });
  const runtime = new VoiceAgentRuntime({ client,
    onAudioSegment: async ({ segment }) => receivedAudio.push(Buffer.from(segment.data, 'base64').toString()),
    transcribeAudio: async ({ segments }) => { transcripts.push(segments.length); return 'Can you hear me?'; },
    respond: async ({ transcript: text }) => { events.push(text); return 'Yes, loud and clear.'; },
    synthesizeSpeech: async () => ({ mimeType: 'audio/wav', bytes: Buffer.from('RIFF-agent-voice'), durationMs: 700 }),
    onResult: (event) => { if (!('data' in event)) events.push(event.type); if (event.type === 'reply-queued') resolveReplied(event); }
  });
  await runtime.sync();
  const result = await replied;
  assert.deepEqual(receivedAudio, ['synthetic-owner-speech', 'synthetic-silence']);
  assert.deepEqual(transcripts, [1]);
  assert.ok(events.includes('Can you hear me?'));
  assert.equal(result.type, 'reply-queued');
  assert.equal(client.requests.some((item) => item.pathname === '/agent-link/v1/voice-call/reply'), true);
  assert.equal(client.requests.find((item) => item.pathname.endsWith('/reply')).options.body.audio.mimeType, 'audio/wav');
  assert.equal(Buffer.from(client.requests.find((item) => item.pathname.endsWith('/reply')).options.body.audio.data, 'base64').toString(), 'RIFF-agent-voice');
  assert.equal(client.requests.filter((item) => item.pathname === '/agent-link/v1/voice-call/media')[0].options.body.callId, 'call-audio');
  runtime.close();
});

test('owner mute discards late audio returned by an already pending call-media request', async () => {
  const client = new FakeClient(); let finishMedia; let received = 0;
  client.linkRequest = async (pathname, options) => {
    client.requests.push({ pathname, options });
    if (pathname === '/agent-link/v1/voice-call') return { ok: true, body: { voiceCall: { id: 'call-muted', status: 'active', ownerMuted: false } } };
    if (pathname === '/agent-link/v1/voice-call/media') return new Promise((resolve) => { finishMedia = resolve; });
    return { ok: true, body: {} };
  };
  const runtime = new VoiceAgentRuntime({ client, onAudioSegment: () => { received += 1; }, respond: async () => 'No.' });
  await runtime.sync();
  await tick();
  client.emit({ type: 'voice.call.muted', metadata: { callId: 'call-muted' } });
  finishMedia({ ok: true, body: { voiceCall: { id: 'call-muted', status: 'active' }, audio: [{ sequence: 1, data: 'cHJpdmF0ZQ==', durationMs: 1000 }] } });
  await tick();
  assert.equal(received, 0);
  runtime.close();
});

test('active call audio polling retries network and transient HTTP failures and resumes at the same cursor', async () => {
  const client = new FakeClient(); let mediaCalls = 0; const received = []; const results = [];
  client.linkRequest = async (pathname, options) => {
    client.requests.push({ pathname, options });
    if (pathname === '/agent-link/v1/voice-call') return { ok: true, body: { voiceCall: { id: 'call-retry', status: 'active', ownerMuted: false } } };
    if (pathname === '/agent-link/v1/voice-call/media') {
      mediaCalls += 1;
      if (mediaCalls === 1) throw new Error('temporary relay disconnect');
      if (mediaCalls === 2) return { ok: false, status: 503, body: { error: 'Relay temporarily unavailable.' } };
      if (mediaCalls === 3) return { ok: true, body: { voiceCall: { id: 'call-retry', status: 'active' }, audio: [{ sequence: 1, data: 'eA==', durationMs: 1000 }], replay: { audio: { gap: false } } } };
      return { ok: true, body: { voiceCall: { id: 'call-retry', status: 'ended' }, audio: [] } };
    }
    return { ok: true, body: {} };
  };
  const runtime = new VoiceAgentRuntime({ client, respond: async () => 'Okay.', onAudioSegment: ({ segment }) => received.push(segment.sequence), sleepFn: async () => {}, onResult: (result) => results.push(result) });
  await runtime.sync();
  await waitFor(() => mediaCalls === 4);
  await tick();
  assert.deepEqual(received, [1]);
  assert.equal(client.requests.filter((item) => item.pathname.endsWith('/voice-call/media'))[1].options.body.afterAudioSequence, 0);
  assert.deepEqual(results.filter((item) => item.type === 'audio-error' && item.retrying === true).map(item => item.attempt), [1, 2]);
  assert.equal(runtime.audioReceiver, null);
  runtime.close();
});

test('active call audio polling does not retry a revoked or policy-denied media request', async () => {
  const client = new FakeClient(); let mediaCalls = 0; const results = [];
  client.linkRequest = async (pathname, options) => {
    client.requests.push({ pathname, options });
    if (pathname === '/agent-link/v1/voice-call') return { ok: true, body: { voiceCall: { id: 'call-denied', status: 'active', ownerMuted: false } } };
    if (pathname === '/agent-link/v1/voice-call/media') { mediaCalls += 1; return { ok: false, status: 403, body: { error: 'The approved permission is no longer available.' } }; }
    return { ok: true, body: {} };
  };
  const runtime = new VoiceAgentRuntime({ client, respond: async () => 'No reply.', onAudioSegment: () => {}, sleepFn: async () => {}, onResult: (result) => results.push(result) });
  await runtime.sync();
  await waitFor(() => results.some((item) => item.type === 'audio-error'));
  await tick();
  assert.equal(mediaCalls, 1);
  assert.equal(results.some((item) => item.retrying === true), false);
  runtime.close();
});

test('muting an active call cancels the transient-media retry delay', async () => {
  const client = new FakeClient(); let mediaCalls = 0; const results = [];
  client.linkRequest = async (pathname, options) => {
    client.requests.push({ pathname, options });
    if (pathname === '/agent-link/v1/voice-call') return { ok: true, body: { voiceCall: { id: 'call-mute-retry', status: 'active', ownerMuted: false } } };
    if (pathname === '/agent-link/v1/voice-call/media') { mediaCalls += 1; return { ok: false, status: 503, body: { error: 'Temporary relay failure.' } }; }
    return { ok: true, body: {} };
  };
  const runtime = new VoiceAgentRuntime({ client, respond: async () => 'No reply.', onAudioSegment: () => {}, onResult: (result) => results.push(result) });
  await runtime.sync();
  await waitFor(() => results.some((item) => item.retrying === true));
  client.emit({ type: 'voice.call.muted', metadata: { callId: 'call-mute-retry' } });
  await waitFor(() => runtime.audioReceiver === null);
  assert.equal(mediaCalls, 1);
  runtime.close();
});
