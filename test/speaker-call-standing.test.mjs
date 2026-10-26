import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDesktopBridgeRequest } from '../lib/desktop-bridge-routes.mjs';
import { startDesktopBridge, defaultDesktopBridge } from '../lib/desktop-bridge.mjs';
import { startDesktopMedia, resetDesktopMediaForTests } from '../lib/desktop-media.mjs';
import { startVoiceCall, initiateVoiceCall, answerVoiceCall, beginVoiceTurn, endVoiceCall, muteVoiceCall, publicVoiceCall, resetVoiceCallForTests } from '../lib/voice-call.mjs';
import { VoiceCallTranscriptBuffer } from '../lib/voice-call-transcripts.mjs';

test('call recognition carries its call ID and drops results after mute, hang-up, or replacement', async () => {
  resetDesktopMediaForTests(); resetVoiceCallForTests();
  try {
    const linkId = 'recognition-standing';
    startDesktopMedia({ linkId, microphoneGranted: true, speakerGranted: true });
    startVoiceCall({ linkId, microphoneGranted: true, speakerGranted: true });
    answerVoiceCall(linkId);
    const originalCallId = publicVoiceCall().id;
    const connection = { id: linkId, status: 'connected', capabilities: ['microphone-listen', 'speaker-output'], events: [], nextSequence: 1 };
    let emit, response;
    const queued = connection.events, saved = [];
    const ctx = {
      state: { settings: { desktopBridge: startDesktopBridge(defaultDesktopBridge(), { linkId, viewGranted: true }) }, agentLinks: [connection] },
      pathname: '/api/desktop-bridge/media/microphone', method: 'POST',
      readBody: async () => ({ mimeType: 'audio/webm', data: 'eA==', durationMs: 500 }),
      json: (_res, status, body) => { response = { status, body }; },
      localTranscriber: { enqueue: (_connection, _chunk, callback) => { emit = callback; return { queued: true }; } },
      onVoiceTranscript: item => saved.push(item), saveState: async () => {}
    };
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.equal(response.status, 202);
    const event = { type: 'speech.transcript.final', text: 'Synthetic call sentence.', metadata: { source: 'owner-microphone' } };
    emit(event);
    assert.equal(queued[0].metadata.callId, originalCallId);
    assert.equal(saved.length, 1);
    muteVoiceCall(linkId, true); emit(event);
    endVoiceCall(linkId); emit(event);
    startVoiceCall({ linkId, microphoneGranted: true, speakerGranted: true }); answerVoiceCall(linkId); emit(event);
    assert.equal(queued.length, 1);
    assert.equal(saved.length, 1);
  } finally { resetDesktopMediaForTests(); resetVoiceCallForTests(); }
});

test('a transcript captured before a call cannot enter the call transcript after it starts', async () => {
  resetDesktopMediaForTests(); resetVoiceCallForTests();
  try {
    const linkId = 'pre-call-transcript-link';
    startDesktopMedia({ linkId, microphoneGranted: true, speakerGranted: true });
    const connection = { id: linkId, status: 'connected', capabilities: ['microphone-listen', 'speaker-output'], events: [], nextSequence: 1 };
    const state = { settings: { desktopBridge: startDesktopBridge(defaultDesktopBridge(), { linkId, viewGranted: true }) }, agentLinks: [connection] };
    let emit, response; const saved = [];
    const ctx = { state, pathname: '/api/desktop-bridge/media/microphone', method: 'POST',
      readBody: async () => ({ mimeType: 'audio/webm', data: 'eA==', durationMs: 500 }),
      json: (_res, status, body) => { response = { status, body }; },
      localTranscriber: { enqueue: (_connection, _chunk, callback, options) => { assert.equal(options.activeCall, false); emit = callback; return { queued: true }; } },
      onVoiceTranscript: item => saved.push(item), saveState: async () => {} };
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.equal(response.status, 202);
    startVoiceCall({ linkId, microphoneGranted: true, speakerGranted: true }); answerVoiceCall(linkId);
    emit({ type: 'speech.transcript.final', text: 'This was spoken before the call.', metadata: { source: 'owner-microphone' } });
    assert.deepEqual(saved, []);
  } finally { resetDesktopMediaForTests(); resetVoiceCallForTests(); }
});

test('existing authorized owner speaker poll returns only its exact live call standing',async()=>{
  resetDesktopMediaForTests();resetVoiceCallForTests();
  try {
    startDesktopMedia({linkId:'synthetic-a',speakerGranted:true,microphoneGranted:true});
    startVoiceCall({linkId:'synthetic-a',speakerGranted:true,microphoneGranted:true});answerVoiceCall('synthetic-a');beginVoiceTurn('synthetic-a');
    let result;
    const state={settings:{desktopBridge:startDesktopBridge(defaultDesktopBridge(),{linkId:'synthetic-a',viewGranted:true})}, agentLinks:[{id:'synthetic-a',status:'connected',capabilities:['microphone-listen','speaker-output']}]};
    const ctx={state,pathname:'/api/desktop-bridge/media',method:'POST',readBody:async()=>({}),json:(_res,status,body)=>{result={status,body};}};
    await handleDesktopBridgeRequest({}, {}, ctx);assert.equal(result.status,200);assert.equal(result.body.voiceCall.phase,'thinking');
    state.settings.desktopBridge=startDesktopBridge(defaultDesktopBridge(),{linkId:'synthetic-b',viewGranted:true});
    startDesktopMedia({linkId:'synthetic-b',speakerGranted:true});await handleDesktopBridgeRequest({}, {}, ctx);
    assert.equal(result.status,200); // Another desktop session must not replace the active call.
    assert.equal(result.body.voiceCall.linkId, 'synthetic-a');
    state.agentLinks[0].capabilities = [];
    await handleDesktopBridgeRequest({}, {}, ctx);assert.notEqual(result.status,200);
    state.settings.desktopBridge.enabled=false;await handleDesktopBridgeRequest({}, {}, ctx);assert.notEqual(result.status,200);
  } finally {resetDesktopMediaForTests();resetVoiceCallForTests();}
});

test('owner desktop-bridge poll returns only its active Link transcript when local transcription is enabled', async () => {
  resetDesktopMediaForTests(); resetVoiceCallForTests();
  try {
    const linkId = 'synthetic-transcript-link';
    startDesktopMedia({ linkId, speakerGranted: true, microphoneGranted: true });
    const voiceCall = initiateVoiceCall({ linkId, callerName: 'Test agent', microphoneGranted: true, speakerGranted: true });
    answerVoiceCall(linkId, { by: 'owner', callId: voiceCall.id });
    const current = publicVoiceCall();
    const transcripts = new VoiceCallTranscriptBuffer();
    transcripts.begin(current);
    transcripts.add({ linkId, call: current, event: { type: 'speech.transcript.final', text: 'Local-only transcript.' } });
    const connection = { id: linkId, status: 'connected', capabilities: ['microphone-listen', 'speaker-output'], transcription: { enabled: true, memoryOnly: false } };
    const state = { settings: { desktopBridge: startDesktopBridge(defaultDesktopBridge(), { linkId, viewGranted: true }) }, agentLinks: [connection] };
    let result;
    const ctx = { state, pathname: '/api/desktop-bridge', method: 'GET', json: (_res, status, body) => { result = { status, body }; }, getVoiceCallTranscripts: options => transcripts.read(options) };
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.transcripts.map(line => line.text), ['Local-only transcript.']);
    delete connection.capabilities; // Legacy Link records fail closed rather than crashing the call UI.
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.deepEqual(result.body.transcripts, []);
    connection.capabilities = ['microphone-listen', 'speaker-output'];
    connection.transcription.memoryOnly = true;
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.deepEqual(result.body.transcripts, []);
    state.settings.desktopBridge = startDesktopBridge(defaultDesktopBridge(), { linkId: 'another-link', viewGranted: true });
    startDesktopMedia({ linkId: 'another-link', microphoneGranted: true, speakerGranted: true });
    connection.transcription.memoryOnly = false;
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.deepEqual(result.body.transcripts.map(line => line.text), ['Local-only transcript.']);
    connection.status = 'revoked';
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.deepEqual(result.body.transcripts, []);
  } finally { resetDesktopMediaForTests(); resetVoiceCallForTests(); }
});

test('an accepted agent-initiated call automatically exposes local transcript events', async () => {
  resetDesktopMediaForTests(); resetVoiceCallForTests();
  try {
    const linkId = 'synthetic-incoming-transcript-link';
    const connection = { id: linkId, agentId: 'synthetic-agent', status: 'connected', capabilities: ['microphone-listen', 'speaker-output'], transcription: { enabled: true, memoryOnly: false }, events: [], nextSequence: 1 };
    const state = { settings: { desktopBridge: startDesktopBridge(defaultDesktopBridge(), { linkId, viewGranted: true }) }, agentLinks: [connection] };
    startDesktopMedia({ linkId, speakerGranted: true, microphoneGranted: true });
    const offered = initiateVoiceCall({ linkId, callerName: 'Synthetic agent', microphoneGranted: true, speakerGranted: true });
    const transcripts = new VoiceCallTranscriptBuffer();
    let emit, result;
    const ctx = { state, pathname: '/api/desktop-bridge/voice-call/accept', method: 'POST',
      readBody: async () => ({ callId: offered.id }),
      json: (_res, status, body) => { result = { status, body }; },
      localTranscriber: { enqueue: (_connection, _chunk, callback) => { emit = callback; } },
      onVoiceTranscript: item => transcripts.add(item), onVoiceCallStarted: voiceCall => transcripts.begin(voiceCall),
      connectorPolicy: () => null, addReceipt: () => ({}), saveState: async () => {} };
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.equal(result.status, 200);
    ctx.pathname = '/api/desktop-bridge/media/microphone';
    ctx.readBody = async () => ({ mimeType: 'audio/webm', data: 'eA==', durationMs: 500 });
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.equal(result.status, 202);
    emit({ type: 'speech.transcript.final', text: 'Synthetic incoming call sentence.', metadata: { source: 'owner-microphone' } });

    ctx.pathname = '/api/desktop-bridge'; ctx.method = 'GET';
    ctx.getVoiceCallTranscripts = options => transcripts.read(options);
    await handleDesktopBridgeRequest({}, {}, ctx);
    assert.deepEqual(result.body.transcripts.map(line => line.text), ['Synthetic incoming call sentence.']);
  } finally { resetDesktopMediaForTests(); resetVoiceCallForTests(); }
});
