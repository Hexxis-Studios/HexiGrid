import { publishSpeakerChunk } from './desktop-media.mjs';
import { beginVoiceTurn, finishVoiceTurn, markVoiceSpeaking, recordVoiceCallReply, requireVoiceCall, voiceTurnStillActive } from './voice-call.mjs';
import { synthesizeLocalSpeech } from './local-tts.mjs';

export function splitVoiceReply(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 240) throw Object.assign(new Error('Voice replies must contain 1–240 characters.'), { status: 400 });
  const parts = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= 90) { parts.push(remaining); break; }
    const boundary = remaining.lastIndexOf(' ', 90);
    const length = boundary >= 45 ? boundary : 90;
    parts.push(remaining.slice(0, length).trim());
    remaining = remaining.slice(length).trim();
  }
  return parts;
}

/** Text-only replies are spoken on the owner device using the selected agent voice. */
export function publishVoiceReplyText(linkId, text) {
  const active = requireVoiceCall(linkId, ['active']);
  if (active.ownerMuted) throw Object.assign(new Error('The owner muted this voice call.'), { status: 409 });
  const clean = splitVoiceReply(text).join(' ');
  const call = recordVoiceCallReply(linkId, clean, 'browser-voice');
  return { segments: 0, partial: false, synthetic: false, deliveryStatus: 'text-ready', playbackVerified: false, replySequence: call.replySequence, outputMode: 'browser-voice' };
}

/** Provider-generated audio may be relayed intact so the agent keeps its own voice. */
export function publishVoiceReplyAudio(linkId, text, audio = {}) {
  // Refuse a stale invitation before publishing any playable bytes.
  const active = requireVoiceCall(linkId, ['active']);
  if (active.ownerMuted) throw Object.assign(new Error('The owner muted this voice call.'), { status: 409 });
  const clean = splitVoiceReply(text).join(' ');
  const mimeType = String(audio.mimeType || '').trim().toLowerCase();
  const allowedMimeTypes = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4']);
  const encoded = String(audio.data || '');
  if (!allowedMimeTypes.has(mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw Object.assign(new Error('Agent audio must be valid base64 in a supported audio format.'), { status: 400 });
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 680 * 1024) throw Object.assign(new Error('Agent audio must be between 1 byte and 680 KiB.'), { status: 400 });
  const durationMs = Math.max(100, Math.min(2500, Number(audio.durationMs) || 1000));
  const queued = publishSpeakerChunk(linkId, { mimeType, data: encoded, durationMs });
  const call = recordVoiceCallReply(linkId, clean, 'audio');
  markVoiceSpeaking(linkId);
  return { segments: 1, partial: false, synthetic: false, deliveryStatus: 'queued', playbackVerified: false, replySequence: call.replySequence, audioSequence: queued.sequence, outputMode: 'audio' };
}

/** Called only after a paired agent's own runtime has produced reply text. */
export async function publishVoiceReply(linkId, text, { synthesize = synthesizeLocalSpeech } = {}) {
  const parts = splitVoiceReply(text);
  const turn = beginVoiceTurn(linkId);
  const started = performance.now();
  let segments = 0;
  try {
    for (const part of parts) {
      const result = await synthesize(part, { signal: turn.controller.signal });
      if (!voiceTurnStillActive(turn)) throw Object.assign(new Error('The voice reply was interrupted.'), { status: 409 });
      if (!Buffer.isBuffer(result.bytes) || result.bytes.length > 680 * 1024 || result.mimeType !== 'audio/wav') throw Object.assign(new Error('The local voice segment is invalid or too large.'), { status: 502 });
      const queued = publishSpeakerChunk(linkId, { mimeType: result.mimeType, data: result.bytes.toString('base64'), durationMs: 1000 });
      segments += 1;
      console.info('[HexiGrid voice audio] TTS segment generated and queued', { sequence: queued.sequence, mimeType: result.mimeType, bytes: result.bytes.length, segment: segments });
      if (segments === 1) markVoiceSpeaking(linkId);
    }
    if (!voiceTurnStillActive(turn)) throw Object.assign(new Error('The voice reply was interrupted.'), { status: 409 });
    return { segments, partial: false, synthetic: false, deliveryStatus: 'queued', playbackVerified: false, synthesisMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch (error) {
    // Once a segment is queued it may already be audible. Report partial delivery
    // explicitly so a caller never retries the whole phrase blindly.
    if (segments && voiceTurnStillActive(turn) && error?.status !== 409) {
      return { segments, partial: true, synthetic: false, deliveryStatus: 'partially-queued', playbackVerified: false, error: 'Speech generation stopped after a queued segment. Browser playback is unconfirmed; do not retry automatically.', synthesisMs: Math.round((performance.now() - started) * 10) / 10 };
    }
    throw error;
  } finally { finishVoiceTurn(turn); }
}
