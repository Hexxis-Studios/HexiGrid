const MAX_SDP_LENGTH = 160_000;
const MAX_INSTRUCTIONS_LENGTH = 12_000;

const clean = (value, max) => String(value || '').trim().slice(0, max);

export function validateRealtimeCall(input = {}) {
  const sdp = clean(input.sdp, MAX_SDP_LENGTH);
  const model = clean(input.model, 240);
  const voice = clean(input.voice, 200);
  const instructions = clean(input.instructions, MAX_INSTRUCTIONS_LENGTH);
  if (!sdp.startsWith('v=0\r\n') && !sdp.startsWith('v=0\n')) throw new Error('The browser did not provide a valid WebRTC offer.');
  if (!model) throw new Error('Choose a realtime model.');
  return { sdp, model, voice, instructions };
}

export async function createRealtimeCall(provider, secret, input, { fetcher = fetch, signal } = {}) {
  if (!['openai-chat', 'openai-responses'].includes(provider.apiStyle || 'openai-chat')) {
    throw new Error('Realtime calling currently requires an OpenAI-compatible Realtime endpoint.');
  }
  if (!secret) throw new Error('This realtime provider needs a protected API key.');
  const request = validateRealtimeCall(input);
  const session = { type: 'realtime', model: request.model };
  if (request.instructions) session.instructions = request.instructions;
  if (request.voice) session.audio = { output: { voice: /^voice_[A-Za-z0-9_-]+$/.test(request.voice) ? { id: request.voice } : request.voice } };
  const form = new FormData();
  form.set('sdp', new Blob([request.sdp], { type: 'application/sdp' }), 'offer.sdp');
  form.set('session', new Blob([JSON.stringify(session)], { type: 'application/json' }), 'session.json');
  const timeout = AbortSignal.timeout(60_000);
  const combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal || timeout);
  const response = await fetcher(`${provider.baseUrl}/realtime/calls`, {
    method: 'POST',
    redirect: 'error',
    signal: combined,
    headers: { authorization: `Bearer ${secret}` },
    body: form
  }).catch((error) => {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error('The realtime provider could not be reached.');
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'The realtime provider rejected the saved key or model permission.'
      : `Realtime call setup failed (${response.status}).`);
  }
  const answerSdp = await response.text();
  if ((!answerSdp.startsWith('v=0\r\n') && !answerSdp.startsWith('v=0\n')) || answerSdp.length > MAX_SDP_LENGTH) {
    throw new Error('The realtime provider returned an invalid WebRTC answer.');
  }
  return { answerSdp };
}

export const realtimeCallLimits = Object.freeze({ maxSdpLength: MAX_SDP_LENGTH, maxInstructionsLength: MAX_INSTRUCTIONS_LENGTH });
