/**
 * Agent-side voice loop. The host agent supplies its own cognition and, when it
 * does not use HexiGrid's local transcriber, an audio-to-text adapter.
 */
import { companionRetryDelay } from './companion-connection.mjs';

const MAX_INPUT_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_AUDIO_SEGMENTS = 120;
const MAX_INPUT_AUDIO_MS = 120_000;
const MAX_PENDING_TRANSCRIPTS = 32;
const RETRYABLE_MEDIA_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function waitForRetry(signal, delayMs) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class VoiceAgentRuntime {
  constructor({ client, respond, transcribeAudio = null, synthesizeSpeech = null, onAudioSegment = null, onResult = () => {}, sleepFn = waitForRetry } = {}) {
    if (!client?.addEventListener || !client?.linkRequest || typeof respond !== 'function') throw new Error('A connected Link client and cognition callback are required.');
    if (transcribeAudio !== null && typeof transcribeAudio !== 'function') throw new Error('transcribeAudio must be a function when provided.');
    if (synthesizeSpeech !== null && typeof synthesizeSpeech !== 'function') throw new Error('synthesizeSpeech must be a function when provided.');
    if (onAudioSegment !== null && typeof onAudioSegment !== 'function') throw new Error('onAudioSegment must be a function when provided.');
    this.client = client;
    this.respond = respond;
    this.transcribeAudio = transcribeAudio;
    this.synthesizeSpeech = synthesizeSpeech;
    this.onAudioSegment = onAudioSegment;
    this.onResult = onResult;
    this.sleepFn = sleepFn;
    this.callId = '';
    this.muted = false;
    this.onHold = false;
    this.mediaEpoch = 0;
    this.turn = null;
    this.pendingTranscripts = [];
    this.answerPromise = null;
    this.audioReceiver = null;
    this.audioSequence = 0;
    this.audioCallId = '';
    this.inputAudio = [];
    this.inputAudioBytes = 0;
    this.inputAudioMs = 0;
    this.onEvent = (event) => this.handleEvent(event.detail);
    client.addEventListener('event', this.onEvent);
  }

  setCallId(callId) {
    const next = String(callId || '');
    if (next !== this.callId) {
      this.clearInputAudio();
      this.pendingTranscripts = [];
      this.stopTurn();
      this.mediaEpoch = 0;
    }
    if (next !== this.audioCallId) { this.audioCallId = next; this.audioSequence = 0; }
    this.callId = next;
  }

  async sync() {
    const result = await this.client.linkRequest('/agent-link/v1/voice-call');
    if (!result.ok) throw new Error(result.body?.error || 'Voice-call state is unavailable.');
    const current = result.body?.voiceCall;
    if (current?.status === 'ringing' && current.id) {
      this.stopAudioReceiver(); this.setCallId(current.id); this.muted = true;
      this.onResult({ type: 'ringing', callId: current.id, expiresAt: current.expiresAt });
    } else if (current?.status === 'offered' && current.id) this.handleEvent({ type: 'voice.call.offered', metadata: { callId: current.id } });
    else if (current?.status === 'active' && current.id) {
      this.setCallId(current.id); this.onHold = current.onHold === true; this.mediaEpoch = Number(current.mediaEpoch || 0); this.muted = current.ownerMuted === true || this.onHold;
      if (this.muted) { this.stopAudioReceiver(); this.stopTurn(); this.pendingTranscripts = []; } else this.startAudioReceiver();
    } else { this.stopAudioReceiver(); this.stopTurn(); this.setCallId(''); }
    return current;
  }

  handleEvent(event = {}) {
    const eventCallId = String(event.metadata?.callId || '');
    if (event.type === 'voice.call.ringing') {
      this.stopAudioReceiver(); this.stopTurn(); this.setCallId(eventCallId); this.mediaEpoch = Number(event.metadata?.mediaEpoch || 0); this.muted = true; this.answerPromise = null;
      this.onResult({ type: 'ringing', callId: this.callId, expiresAt: event.metadata?.expiresAt }); return;
    }
    if (event.type === 'voice.call.accepted' && this.callId === eventCallId) {
      if (Number.isSafeInteger(event.metadata?.mediaEpoch)) this.mediaEpoch = event.metadata.mediaEpoch;
      this.muted = false; this.onResult({ type: 'accepted', callId: this.callId }); this.startAudioReceiver(); return;
    }
    if (event.type === 'voice.call.offered') {
      this.stopAudioReceiver(); this.stopTurn(); this.setCallId(eventCallId); this.mediaEpoch = Number(event.metadata?.mediaEpoch || 0); this.onHold = event.metadata?.onHold === true; this.muted = this.onHold;
      const expected = this.callId;
      this.answerPromise = this.client.linkRequest('/agent-link/v1/voice-call/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: {} })
        .then((result) => {
          if (!result.ok || this.callId !== expected) throw new Error('The voice call could not be answered.');
          const answeredCall = result.body?.voiceCall;
          if (typeof answeredCall?.onHold === 'boolean') this.onHold = answeredCall.onHold;
          if (Number.isSafeInteger(answeredCall?.mediaEpoch)) this.mediaEpoch = answeredCall.mediaEpoch;
          this.muted = this.onHold || answeredCall?.ownerMuted === true;
          this.onResult({ type: 'answered', callId: expected }); this.startAudioReceiver();
        }).catch(() => { this.onResult({ type: 'error', reason: 'The voice call could not be answered.' }); if (this.callId === expected) { this.stopAudioReceiver(); this.callId = ''; } });
      return;
    }
    if (event.type === 'voice.call.held' && eventCallId === this.callId) { this.onHold = true; this.muted = true; this.stopAudioReceiver(); this.stopTurn(); this.pendingTranscripts = []; this.clearInputAudio(); return; }
    if (event.type === 'voice.call.resumed' && eventCallId === this.callId) { this.onHold = false; this.muted = false; this.mediaEpoch = Number(event.metadata?.mediaEpoch || 0); this.startAudioReceiver(); return; }
    if (event.type === 'voice.call.muted' && (!eventCallId || eventCallId === this.callId)) { this.muted = true; this.stopAudioReceiver(); this.stopTurn(); this.pendingTranscripts = []; this.clearInputAudio(); return; }
    if (event.type === 'voice.call.unmuted' && (!eventCallId || eventCallId === this.callId)) { this.muted = false; this.startAudioReceiver(); return; }
    if (event.type === 'voice.call.interrupted' && (!eventCallId || eventCallId === this.callId)) { this.pendingTranscripts = []; this.stopTurn(); this.onResult({ type: 'interrupted', callId: this.callId }); return; }
    if (event.type === 'voice.call.ended' || event.type === 'emergency.stop') {
      if (eventCallId && this.callId && eventCallId !== this.callId) return;
      const callId = this.callId; this.stopAudioReceiver(); this.stopTurn(); this.pendingTranscripts = []; this.clearInputAudio(); this.setCallId('');
      if (callId) this.onResult({ type: 'ended', callId, reason: String(event.metadata?.reason || (event.type === 'emergency.stop' ? 'emergency-stop' : 'ended')) }); return;
    }
    if (this.transcribeAudio || event.type !== 'speech.transcript.final' || event.metadata?.source !== 'owner-microphone' || !this.callId || this.muted) return;
    if (eventCallId !== this.callId || event.metadata?.mediaEpoch !== this.mediaEpoch) return;
    const text = String(event.text || '').slice(0, 20_000);
    if (!text.trim()) return;
    const transcript = { text, callId: this.callId, mediaEpoch: this.mediaEpoch };
    if (this.turn) {
      if (this.pendingTranscripts.length >= MAX_PENDING_TRANSCRIPTS) {
        this.onResult({ type: 'transcript-queue-full', callId: this.callId, limit: MAX_PENDING_TRANSCRIPTS });
        return;
      }
      this.pendingTranscripts.push(transcript);
      this.onResult({ type: 'transcript-queued', callId: this.callId, pending: this.pendingTranscripts.length });
      return;
    }
    void this.processTurn(transcript.text, transcript.callId, transcript.mediaEpoch);
  }

  startAudioReceiver() {
    if ((!this.transcribeAudio && !this.onAudioSegment) || !this.callId || this.muted) return;
    if (this.audioReceiver?.callId === this.callId && !this.audioReceiver.controller.signal.aborted) return;
    this.stopAudioReceiver();
    const receiver = { callId: this.callId, controller: new AbortController() };
    this.audioReceiver = receiver;
    void this.receiveAudio(receiver);
  }

  stopAudioReceiver() {
    this.audioReceiver?.controller.abort();
    this.audioReceiver = null;
  }

  async receiveAudio(receiver) {
    const { callId, controller } = receiver;
    const active = () => !controller.signal.aborted && this.audioReceiver === receiver && this.callId === callId && !this.muted;
    let failures = 0;
    const retry = async (reason) => {
      failures += 1;
      const delayMs = companionRetryDelay(failures);
      this.onResult({ type: 'audio-error', callId, reason, retrying: true, attempt: failures, retryInMs: delayMs });
      await this.sleepFn(controller.signal, delayMs);
      return active();
    };
    try {
      while (active()) {
        let result;
        try {
          result = await this.client.linkRequest('/agent-link/v1/voice-call/media', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: { callId, afterAudioSequence: this.audioSequence, waitMs: 8000 }
          });
          if (!active()) break;
        } catch {
          if (!await retry('Owner microphone audio transport failed temporarily.')) break;
          continue;
        }
        if (!result.ok) {
          const status = Number(result.status) || 0;
          if (!RETRYABLE_MEDIA_STATUSES.has(status)) {
            this.onResult({ type: 'audio-error', callId, reason: result.body?.error || 'Owner microphone audio is unavailable.' });
            break;
          }
          if (!await retry(result.body?.error || 'Owner microphone audio is temporarily unavailable.')) break;
          continue;
        }
        failures = 0;
        const media = result.body || {};
        if (media.voiceCall?.id !== callId || media.voiceCall?.status !== 'active' || media.voiceCall?.ownerMuted) break;
        if (media.replay?.audio?.gap) this.onResult({ type: 'audio-gap', callId, afterSequence: this.audioSequence, oldestAvailable: media.replay.audio.oldestAvailable });
        for (const segment of media.audio || []) {
          const sequence = Number(segment.sequence);
          if (!Number.isSafeInteger(sequence) || sequence <= this.audioSequence) continue;
          if (!active()) break;
          try { await this.onAudioSegment?.({ callId, segment, signal: controller.signal }); }
          catch { this.onResult({ type: 'audio-adapter-error', callId }); }
          if (!active()) break;
          this.audioSequence = sequence;
          this.onResult({ type: 'audio-received', callId, sequence, durationMs: Number(segment.durationMs) || 0 });
          if (this.transcribeAudio) await this.consumeAudioSegment(segment, receiver);
        }
      }
    } catch {
      if (active()) this.onResult({ type: 'audio-error', callId, reason: 'Owner microphone audio transport failed.' });
    } finally {
      if (this.audioReceiver === receiver) this.audioReceiver = null;
    }
  }

  async consumeAudioSegment(segment, receiver) {
    if (segment.speechActive === false) { await this.flushInputAudio(receiver); return; }
    const encodedBytes = Math.ceil(String(segment.data || '').length * 3 / 4);
    const duration = Math.max(0, Number(segment.durationMs) || 0);
    if (encodedBytes > MAX_INPUT_AUDIO_BYTES) { this.onResult({ type: 'audio-limit', callId: receiver.callId }); return; }
    if (this.inputAudio.length >= MAX_INPUT_AUDIO_SEGMENTS || this.inputAudioBytes + encodedBytes > MAX_INPUT_AUDIO_BYTES || this.inputAudioMs + duration > MAX_INPUT_AUDIO_MS) {
      await this.flushInputAudio(receiver);
      if (receiver.controller.signal.aborted) return;
    }
    this.inputAudio.push(segment); this.inputAudioBytes += encodedBytes; this.inputAudioMs += duration;
    // Older capture clients do not provide speech activity. Transcribe each
    // complete one-second MediaRecorder segment rather than waiting indefinitely.
    if (segment.speechActive !== true) await this.flushInputAudio(receiver);
  }

  async flushInputAudio(receiver) {
    if (!this.inputAudio.length || !this.transcribeAudio) return;
    const segments = this.inputAudio; this.clearInputAudio();
    try {
      const result = await this.transcribeAudio({ callId: receiver.callId, segments, signal: receiver.controller.signal });
      if (receiver.controller.signal.aborted || this.callId !== receiver.callId || this.muted) return;
      const text = typeof result === 'string' ? result : String(result?.transcript || '');
      if (text.trim()) void this.processTurn(text.slice(0, 20_000));
    } catch {
      if (!receiver.controller.signal.aborted) this.onResult({ type: 'transcription-error', callId: receiver.callId, reason: 'Owner audio could not be transcribed by the configured agent adapter.' });
    }
  }

  clearInputAudio() { this.inputAudio = []; this.inputAudioBytes = 0; this.inputAudioMs = 0; }

  async processTurn(transcript, expectedCallId = this.callId, expectedMediaEpoch = this.mediaEpoch) {
    if (!transcript.trim()) return;
    if (this.turn) {
      if (this.pendingTranscripts.length < MAX_PENDING_TRANSCRIPTS) this.pendingTranscripts.push({
        text: transcript, callId: expectedCallId, mediaEpoch: expectedMediaEpoch
      });
      else this.onResult({ type: 'transcript-queue-full', callId: expectedCallId, limit: MAX_PENDING_TRANSCRIPTS });
      return;
    }
    const callId = expectedCallId;
    const mediaEpoch = expectedMediaEpoch;
    if (this.callId !== callId || this.muted || this.onHold || this.mediaEpoch !== mediaEpoch) return;
    const turn = new AbortController();
    this.turn = turn;
    const current = () => !turn.signal.aborted && this.callId === callId && !this.muted && !this.onHold && this.mediaEpoch === mediaEpoch;
    try {
      await this.answerPromise;
      if (!current()) return;
      const reply = String(await this.respond({ transcript, callId, signal: turn.signal }) || '').trim();
      if (!current()) return;
      if (!reply || reply.length > 240) throw new Error('The cognition callback must return 1–240 characters of speech.');
      const body = { text: reply, callId, mediaEpoch };
      if (this.synthesizeSpeech) {
        const audio = await this.synthesizeSpeech({ text: reply, callId, signal: turn.signal });
        const mimeType = String(audio?.mimeType || '').trim().toLowerCase();
        const data = Buffer.isBuffer(audio?.bytes) ? audio.bytes.toString('base64') : String(audio?.data || '');
        const size = Buffer.byteLength(data, 'base64');
        if (!['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4'].includes(mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || size < 1 || size > 680 * 1024) {
          throw new Error('The agent speech adapter returned invalid or oversized audio.');
        }
        body.audio = { mimeType, data, ...(Number.isFinite(Number(audio.durationMs)) ? { durationMs: Number(audio.durationMs) } : {}) };
      }
      if (!current()) return;
      const result = await this.client.linkRequest('/agent-link/v1/voice-call/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!result.ok) throw new Error(result.body?.error || 'The voice reply was not accepted.');
      const audioQueued = result.body?.outputMode === 'audio' || body.audio;
      this.onResult({ type: result.body?.partial ? 'reply-partially-queued' : audioQueued ? 'reply-queued' : 'reply-ready', callId, segments: result.body?.segments || 0,
        deliveryStatus: result.body?.deliveryStatus || (result.body?.partial ? 'partially-queued' : audioQueued ? 'queued' : 'text-ready'), replySequence: result.body?.replySequence,
        playbackVerified: result.body?.playbackVerified === true,
        ...((result.body?.partial || result.body?.playbackVerified !== true) ? { warning: result.body?.error || (audioQueued ? 'The browser accepted audio, but playback through the owner speakers is not verified.' : 'Text is ready for the owner device to speak with this agent’s configured voice; playback is not verified.') } : {}) });
    } catch {
      if (!turn.signal.aborted) this.onResult({ type: 'error', callId, reason: 'The spoken turn could not be completed.' });
    } finally {
      if (this.turn === turn) this.turn = null;
      this.processNextTranscript();
    }
  }

  processNextTranscript() {
    while (!this.turn && this.pendingTranscripts.length) {
      const next = this.pendingTranscripts.shift();
      if (next.callId !== this.callId || next.mediaEpoch !== this.mediaEpoch || this.muted || this.onHold) continue;
      void this.processTurn(next.text, next.callId, next.mediaEpoch);
      return;
    }
  }

  stopTurn() { this.turn?.abort(); this.turn = null; }
  close() { this.stopAudioReceiver(); this.clearInputAudio(); this.pendingTranscripts = []; this.stopTurn(); this.callId = ''; this.client.removeEventListener('event', this.onEvent); }
}
