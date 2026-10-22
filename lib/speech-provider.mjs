const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4']);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function validateSpeechRequest(input = {}) {
  const model = String(input.model || '').trim().slice(0, 240);
  const voice = String(input.voice || '').trim().slice(0, 200);
  const text = String(input.text || '').trim().slice(0, 12000);
  if (!model) throw new Error('Choose a speech model.');
  if (!voice) throw new Error('Enter a voice name or provider-issued voice ID.');
  if (!text) throw new Error('Enter text for the voice to say.');
  return { model, voice, text };
}

export async function generateSpeechWithProvider(provider, secret, input, { fetcher = fetch, signal } = {}) {
  if (!['openai-chat', 'openai-responses'].includes(provider.apiStyle || 'openai-chat')) throw new Error('This speech connector requires an OpenAI-compatible audio/speech endpoint.');
  const request = validateSpeechRequest(input);
  const timeout = AbortSignal.timeout(180000);
  const combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal || timeout);
  const response = await fetcher(`${provider.baseUrl}/audio/speech`, {
    method: 'POST', redirect: 'error', signal: combined,
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ model: request.model, voice: /^voice_[A-Za-z0-9_-]+$/.test(request.voice) ? { id: request.voice } : request.voice, input: request.text, response_format: 'mp3' })
  }).catch((error) => { if (signal?.aborted || error?.name === 'AbortError') throw error; throw new Error('The speech provider could not be reached.'); });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'The speech provider rejected the saved key or voice permission.' : `Speech generation failed (${response.status}).`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error('The generated voice clip is larger than 20 MB.');
  const mimeType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].toLowerCase();
  if (!AUDIO_TYPES.has(mimeType)) throw new Error('The speech provider returned an unsupported audio format.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error('The generated voice clip is empty or larger than 20 MB.');
  return { bytes, mimeType };
}
