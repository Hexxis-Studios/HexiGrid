const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_DATA = /^data:(audio\/(?:mpeg|mp3|wav|x-wav|ogg|aac|flac|webm|mp4));base64,([A-Za-z0-9+/=]+)$/;

function audioFromDataUrl(value, label) {
  const match = AUDIO_DATA.exec(String(value || ''));
  if (!match) throw new Error(`${label} must be an MP3, WAV, OGG, AAC, FLAC, WebM, or MP4 audio file.`);
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error(`${label} must be smaller than 10 MB.`);
  return { bytes, mimeType: match[1] };
}

const clean = (value, max) => String(value || '').trim().slice(0, max);

export function validateCustomVoiceRequest(input = {}) {
  const name = clean(input.name, 80);
  const language = clean(input.language, 35);
  if (!name) throw new Error('Give the custom voice a name.');
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw new Error('Use a language tag such as en-US.');
  if (input.consentConfirmed !== true) throw new Error('The speaker must explicitly confirm this voice creation.');
  return {
    name,
    language,
    consent: audioFromDataUrl(input.consentAudio, 'The consent recording'),
    sample: audioFromDataUrl(input.sampleAudio, 'The voice sample')
  };
}

async function safeJson(response, failure) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== 'object') throw new Error(failure(response.status));
  return body;
}

export async function createCustomVoice(provider, secret, input, { fetcher = fetch } = {}) {
  if (!['openai-chat', 'openai-responses'].includes(provider.apiStyle || 'openai-chat')) throw new Error('Custom voice creation currently requires an OpenAI-compatible audio API.');
  if (!secret) throw new Error('This custom voice provider needs a protected API key.');
  const request = validateCustomVoiceRequest(input);
  const headers = { authorization: `Bearer ${secret}` };
  const consentForm = new FormData();
  consentForm.set('name', request.name);
  consentForm.set('language', request.language);
  consentForm.set('recording', new Blob([request.consent.bytes], { type: request.consent.mimeType }), 'consent-audio');
  const consentResponse = await fetcher(`${provider.baseUrl}/audio/voice_consents`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000), headers, body: consentForm })
    .catch(() => { throw new Error('The voice provider could not upload the consent recording.'); });
  const consent = await safeJson(consentResponse, (status) => status === 401 || status === 403 ? 'The provider rejected the key or custom-voice permission.' : `Consent upload failed (${status}).`);
  if (!/^cons_[A-Za-z0-9_-]{3,200}$/.test(String(consent.id || ''))) throw new Error('The provider returned an invalid consent record.');

  const voiceForm = new FormData();
  voiceForm.set('name', request.name);
  voiceForm.set('consent', consent.id);
  voiceForm.set('audio_sample', new Blob([request.sample.bytes], { type: request.sample.mimeType }), 'voice-sample');
  try {
    const voiceResponse = await fetcher(`${provider.baseUrl}/audio/voices`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000), headers, body: voiceForm })
      .catch(() => { throw new Error('The voice provider could not create the custom voice.'); });
    const voice = await safeJson(voiceResponse, (status) => status === 401 || status === 403 ? 'The provider rejected the custom-voice permission.' : `Custom voice creation failed (${status}).`);
    if (!/^voice_[A-Za-z0-9_-]{3,200}$/.test(String(voice.id || ''))) throw new Error('The provider returned an invalid custom voice ID.');
    return { voiceId: voice.id, voiceName: clean(voice.name, 80) || request.name, consentId: consent.id };
  } catch (error) {
    await fetcher(`${provider.baseUrl}/audio/voice_consents/${encodeURIComponent(consent.id)}`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30_000), headers }).catch(() => {});
    throw error;
  }
}

export const customVoiceLimits = Object.freeze({ maxAudioBytes: MAX_AUDIO_BYTES });
