import test from 'node:test';
import assert from 'node:assert/strict';
import { startVoiceCall, answerVoiceCall, publicVoiceCall, selectVoiceCall, endVoiceCall, requireVoiceCall, beginVoiceTurn, voiceTurnStillActive, resetVoiceCallForTests } from '../lib/voice-call.mjs';
import { callMediaBridge } from '../lib/call-media-authority.mjs';
import { defaultDesktopBridge, startDesktopBridge, desktopBridgeAuthorized } from '../lib/desktop-bridge.mjs';
import { startDesktopMedia, publishMicrophoneChunk, readDesktopMicrophone, resetDesktopMediaForTests } from '../lib/desktop-media.mjs';
import { handleDesktopBridgeRequest } from '../lib/desktop-bridge-routes.mjs';

test.beforeEach(() => { resetVoiceCallForTests(); resetDesktopMediaForTests(); });
test.afterEach(() => { endVoiceCall(''); resetDesktopMediaForTests(); });
const offer = (linkId, allowAdd = false) => startVoiceCall({ linkId, allowAdd, microphoneGranted: true, speakerGranted: true });
function fixture() {
  const state = { settings: { desktopBridge: startDesktopBridge(defaultDesktopBridge(), { linkId: 'a', viewGranted: true, controlGranted: true }) }, agentLinks: ['a','b'].map(id => ({ id, agentId: id, status: 'connected', capabilities: ['microphone-listen', 'speaker-output'], events: [], nextSequence: 1 })) };
  startDesktopMedia({ linkId: 'a', microphoneGranted: true, speakerGranted: true }); offer('a'); answerVoiceCall('a');
  return state;
}
test('held participants answer without audio and switching cancels the previous reply, including switching back', () => {
  fixture(); offer('b', true); answerVoiceCall('b');
  assert.equal(publicVoiceCall('b').onHold, true);
  assert.equal(publicVoiceCall('b').participants, undefined);
  assert.throws(() => requireVoiceCall('b', ['active']), /on hold/);
  const pending = beginVoiceTurn('a'); const firstEpoch = publicVoiceCall().mediaEpoch;
  selectVoiceCall('b'); assert.equal(voiceTurnStillActive(pending), false);
  assert.throws(() => requireVoiceCall('a', ['active']), /on hold/);
  assert.equal(publicVoiceCall().participants.filter(item => !item.onHold).length, 1);
  selectVoiceCall('a'); assert.ok(publicVoiceCall().mediaEpoch > firstEpoch);
  endVoiceCall('b'); assert.equal(publicVoiceCall().status, 'active');
  endVoiceCall(''); assert.equal(publicVoiceCall().participants.length, 0);
});
test('call selection never transfers desktop control and held Links cannot read call media', () => {
  const state = fixture(), original = structuredClone(state.settings.desktopBridge);
  offer('b', true); answerVoiceCall('b'); assert.throws(() => callMediaBridge(state, 'b'), /on hold/);
  selectVoiceCall('b'); startDesktopMedia({ linkId:'b', microphoneGranted:true, speakerGranted:true, preserveSequences:true });
  assert.equal(callMediaBridge(state, 'b').linkId, 'b');
  assert.equal(callMediaBridge(state, 'b').mediaGrants.camera, false);
  assert.throws(() => callMediaBridge(state, 'a'), /on hold/);
  assert.deepEqual(state.settings.desktopBridge, original);
  assert.throws(() => desktopBridgeAuthorized(original, { linkId:'b', capability:'desktop-control' }), /not active/);
  state.agentLinks[1].capabilities = [];
  assert.throws(() => callMediaBridge(state, 'b'), /approved microphone/);
});
test('audio cursors stay increasing when switching, and old captures/transcripts cannot enter a returned-to participant', async () => {
  const state = fixture();
  const previous = publishMicrophoneChunk('a', { mimeType:'audio/webm', data:'eA==', durationMs:500 });
  let emit, result; const events = [];
  const current = publicVoiceCall();
  const ctx = { state, pathname:'/api/desktop-bridge/media/microphone', method:'POST', readBody:async()=>({ callId:current.id, mediaEpoch:current.mediaEpoch, mimeType:'audio/webm', data:'eA==', durationMs:500 }), json:(_res,status,body)=>{ result={status,body}; }, localTranscriber:{enqueue:(_connection,_chunk,callback)=>{emit=callback;}}, onVoiceTranscript:item=>events.push(item), saveState:async()=>{} };
  await handleDesktopBridgeRequest({}, {}, ctx); assert.equal(result.status,202);
  offer('b', true); answerVoiceCall('b'); selectVoiceCall('b');
  startDesktopMedia({ linkId:'b', microphoneGranted:true, speakerGranted:true, preserveSequences:true });
  const next = publishMicrophoneChunk('b', { mimeType:'audio/webm',data:'eA==',durationMs:500 }); assert.ok(next.sequence > previous.sequence);
  assert.throws(() => readDesktopMicrophone('a',0), /not active/);
  selectVoiceCall('a'); startDesktopMedia({linkId:'a',microphoneGranted:true,speakerGranted:true,preserveSequences:true});
  emit({type:'speech.transcript.final',text:'old synthetic audio'}); assert.equal(events.length,0);
  await handleDesktopBridgeRequest({}, {}, ctx); assert.equal(result.status,409);
});
test('owner policy rejection leaves participants unchanged; ending still works after revocation', async () => {
  const state = fixture(); let result;
  const ctx = {state,pathname:'/api/desktop-bridge/voice-call/add',method:'POST',readBody:async()=>({linkId:'b',approved:true}),json:(_res,status,body)=>{result={status,body};},connectorPolicy:()=>({denied:true,error:'Planning mode'}),addReceipt:()=>{},saveState:async()=>{}};
  await handleDesktopBridgeRequest({}, {}, ctx); assert.equal(result.status,403); assert.equal(publicVoiceCall().participants.length,1);
  state.agentLinks[0].capabilities=[]; ctx.pathname='/api/desktop-bridge/voice-call/end'; ctx.readBody=async()=>({});
  await handleDesktopBridgeRequest({}, {}, ctx); assert.equal(result.status,200); assert.equal(publicVoiceCall().status,'ended');
});
