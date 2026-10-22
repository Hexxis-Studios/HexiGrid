import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { clearDesktopSpeaker, readDesktopSpeaker, resetDesktopMediaForTests, startDesktopMedia } from '../lib/desktop-media.mjs';
import { VoiceAgentRuntime } from '../lib/voice-agent-runtime.mjs';
import { answerVoiceCall, endVoiceCall, interruptVoiceCall, publicVoiceCall, resetVoiceCallForTests, startVoiceCall } from '../lib/voice-call.mjs';
import { publishVoiceReply } from '../lib/voice-reply.mjs';

test.beforeEach(() => { resetVoiceCallForTests(); resetDesktopMediaForTests(); });

function openCall() {
  startDesktopMedia({ linkId: 'link-barge', microphoneGranted: true, speakerGranted: true });
  startVoiceCall({ linkId: 'link-barge', microphoneGranted: true, speakerGranted: true });
  answerVoiceCall('link-barge');
}

class FakeClient extends EventTarget {
  constructor() { super(); this.requests = []; }
  async linkRequest(pathname, options) {
    this.requests.push({ pathname, options });
    return { ok: true, body: pathname.endsWith('/reply') ? { segments: 1 } : { voiceCall: { status: 'active' } } };
  }
  emit(detail) { this.dispatchEvent(new CustomEvent('event', { detail })); }
}

const finalTranscript = (text) => {
  const call = publicVoiceCall();
  return { type: 'speech.transcript.final', text, metadata: { source: 'owner-microphone', callId: call.id, mediaEpoch: call.mediaEpoch } };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('qualified owner speech drops unplayed audio and the new transcript completes a replacement turn', async () => {
  openCall();
  await publishVoiceReply('link-barge', 'This reply will be interrupted.', { synthesize: async () => ({ mimeType: 'audio/wav', bytes: Buffer.from('RIFF-synthetic') }) });
  assert.equal(publicVoiceCall().phase, 'speaking');
  assert.equal(readDesktopSpeaker('link-barge').speaker.length, 1);
  const started = performance.now();
  const interruption = interruptVoiceCall('link-barge', { energy: 0.4 });
  clearDesktopSpeaker('link-barge');
  assert.equal(interruption.interrupted, true);
  assert.ok(performance.now() - started < 50, 'in-process interruption should be bounded below 50 ms');
  assert.equal(readDesktopSpeaker('link-barge').speaker.length, 0);
  assert.equal(publicVoiceCall().phase, 'listening');

  const client = new FakeClient();
  const spoken = [];
  const runtime = new VoiceAgentRuntime({ client, respond: async ({ transcript }) => { spoken.push(transcript); return 'Replacement reply.'; } });
  runtime.callId = publicVoiceCall().id;
  client.emit({ type: 'voice.call.interrupted', metadata: { callId: runtime.callId } });
  client.emit(finalTranscript('My new question.'));
  await tick(); await tick();
  assert.deepEqual(spoken, ['My new question.']);
  assert.equal(client.requests.filter((item) => item.pathname.endsWith('/reply')).length, 1);
  runtime.close();
});

test('noise, empty transcripts, and rapid duplicate interrupts cannot create phantom turns', async () => {
  openCall();
  await publishVoiceReply('link-barge', 'Keep speaking through line noise.', { synthesize: async () => ({ mimeType: 'audio/wav', bytes: Buffer.from('RIFF-noise') }) });
  assert.equal(interruptVoiceCall('link-barge', { energy: 0.04 }).interrupted, false);
  assert.equal(readDesktopSpeaker('link-barge').speaker.length, 1);
  assert.equal(interruptVoiceCall('link-barge', { energy: 0.3 }).interrupted, true);
  clearDesktopSpeaker('link-barge');
  assert.equal(interruptVoiceCall('link-barge', { energy: 0.3 }).interrupted, false);
  assert.equal(publicVoiceCall().interruptionCount, 1);

  const client = new FakeClient();
  let cognitionCalls = 0;
  const runtime = new VoiceAgentRuntime({ client, respond: async () => { cognitionCalls += 1; return 'Never used.'; } });
  runtime.callId = publicVoiceCall().id;
  client.emit({ type: 'voice.call.interrupted', metadata: { callId: runtime.callId } });
  client.emit(finalTranscript('   '));
  await tick();
  assert.equal(cognitionCalls, 0);
  assert.equal(client.requests.filter((item) => item.pathname.endsWith('/reply')).length, 0);
  assert.equal(runtime.turn, null);
  endVoiceCall('link-barge', 'test-finished');
  assert.equal(publicVoiceCall().phase, 'idle');
  runtime.close();
});

test('qualified interruption cancels synthesis, drops its late audio, and cannot disturb a replacement reply', async () => {
  openCall(); let finishOld, finishNew, oldSignal;
  const pending = publishVoiceReply('link-barge', 'Old synthetic reply.', { synthesize: (_text, {signal}) => {
    oldSignal = signal; return new Promise(resolve=>{finishOld=resolve;});
  }});
  assert.equal(publicVoiceCall().phase,'thinking');
  assert.equal(interruptVoiceCall('link-barge',{energy:0.04}).interrupted,false);
  const interruption=interruptVoiceCall('link-barge',{energy:0.4}); clearDesktopSpeaker('link-barge');
  assert.equal(interruption.interrupted,true); assert.equal(oldSignal.aborted,true);
  assert.equal(publicVoiceCall().phase,'listening'); assert.equal(readDesktopSpeaker('link-barge').speaker.length,0);
  const replacement=publishVoiceReply('link-barge','Fresh synthetic reply.',{synthesize:()=>new Promise(resolve=>{finishNew=resolve;})});
  finishOld({mimeType:'audio/wav',bytes:Buffer.from('old-late-audio')}); await assert.rejects(pending,/interrupted/);
  assert.equal(publicVoiceCall().phase,'thinking','old completion must not reset the replacement turn');
  await assert.rejects(()=>publishVoiceReply('link-barge','Duplicate.'),/already in progress/);
  finishNew({mimeType:'audio/wav',bytes:Buffer.from('fresh-audio')}); await replacement;
  assert.equal(publicVoiceCall().phase,'speaking');
  const queued=readDesktopSpeaker('link-barge').speaker; assert.equal(queued.length,1);
  assert.equal(Buffer.from(queued[0].data,'base64').toString(),'fresh-audio');
});

test('failed synthesis restores listening and permits a subsequent reply', async () => {
  openCall();
  await assert.rejects(()=>publishVoiceReply('link-barge','Failed.',{synthesize:async()=>{throw new Error('Synthetic synthesis failure');}}),/Synthetic synthesis failure/);
  assert.equal(publicVoiceCall().phase,'listening'); assert.equal(readDesktopSpeaker('link-barge').speaker.length,0);
  const result=await publishVoiceReply('link-barge','Recovered.',{synthesize:async()=>({mimeType:'audio/wav',bytes:Buffer.from('recovered')})});
  assert.equal(result.segments,1); assert.equal(publicVoiceCall().phase,'speaking');
});

test('browser fast path energy-gates barge-in and clears playback before its server notice', async () => {
  const source = await fs.readFile(new URL('../public/desktop-media.js', import.meta.url), 'utf8');
  assert.match(source, /runtime\.speakerPlaying \|\| runtime\.voiceCallPhase === 'thinking'/);
  assert.match(source, /!runtime\.microphoneMuted && runtime\.microphoneLevel >= 0\.12/);
  assert.match(source, /runtime\.bargeInFrames >= 6/);
  assert.match(source, /runtime\.speakerQueue = \[\];\s*stopSpeakerPlayback\(\);\s*void upload\('\/api\/desktop-bridge\/voice-call\/interrupt'/);
  assert.match(source, /bargeInCooldownUntil = Date\.now\(\) \+ 900/);
});
