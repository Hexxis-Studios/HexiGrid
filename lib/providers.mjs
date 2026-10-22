import { setTimeout as delay } from 'node:timers/promises';

export function validateProvider(input) {
  const name = String(input.name || '').trim().slice(0,80);
  if (!name) throw new Error('Give the provider a name.');
  let url;
  try { url = new URL(input.baseUrl); } catch { throw new Error('Enter a valid API base URL.'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS for remote providers, or HTTP for a model on this computer.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Put the key in the API key field, not the URL.');
  if (requiresProviderKey(url) && !String(input.apiKey || '').trim()) throw new Error('Paste this service’s API key before connecting. Its public model list does not verify chat access.');
  const modelIds = [...new Set(String(input.models || '').split(/[\n,]/).map(x=>x.trim()).filter(Boolean))];
  if (modelIds.length > 200 || modelIds.some(x=>x.length > 240)) throw new Error('Enter no more than 200 model IDs.');
  const apiStyle = ['openai-chat', 'openai-responses', 'anthropic', 'google-gemini'].includes(input.apiStyle) ? input.apiStyle : 'openai-chat';
  const maxOutputTokens = input.maxOutputTokens;
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768)) throw new Error('Output token limit must be an integer from 1 to 32768.');
  const maxInputTokens = input.maxInputTokens;
  if (maxInputTokens !== undefined && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1 || maxInputTokens > 1000000)) throw new Error('Input-context token limit must be an integer from 1 to 1000000.');
  return { name, baseUrl: url.href.replace(/\/$/, ''), modelIds, apiStyle, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), ...(maxInputTokens === undefined ? {} : { maxInputTokens }), local: loopback, enabled: true };
}

function estimateTextTokens(value) {
  return Math.ceil(String(value || '').length / 4);
}

function enforceInputContextLimit(provider, prompt) {
  if (provider.maxInputTokens === undefined) return;
  if (!Number.isSafeInteger(provider.maxInputTokens) || provider.maxInputTokens < 1 || provider.maxInputTokens > 1000000) {
    throw new Error('Input-context token limit must be an integer from 1 to 1000000.');
  }
  if (typeof prompt === 'object' && prompt) {
    const vision = normalizeVisionInput(prompt);
    if (vision) throw new Error('The configured input-context token limit cannot be checked for image input with the available text-only estimate. Remove the image or clear this provider’s input-context limit.');
  }
  const estimated = estimateTextTokens(prompt);
  if (estimated > provider.maxInputTokens) {
    throw new Error(`Request exceeds this provider’s input-context limit (estimated ${estimated} tokens; limit ${provider.maxInputTokens}). Shorten the prompt or raise the configured limit.`);
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal || timeout);
}

export function requiresProviderKey(value) {
  const url = value instanceof URL ? value : new URL(value);
  return ['opencode.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'router.huggingface.co'].includes(url.hostname.toLowerCase());
}

export function normalizeVisionInput(value) {
  if (!value) return null;
  const source = typeof value === 'string' ? value : value.imageDataUrl;
  const text = typeof value === 'object' ? String(value.text || '').trim() : '';
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(source || ''));
  if (!match) throw new Error('The attached frame must be a PNG, JPEG, or WebP image.');
  const estimatedBytes = Math.floor(match[2].length * 3 / 4);
  if (estimatedBytes < 1 || estimatedBytes > 1536 * 1024) throw new Error('The attached frame must be smaller than 1.5 MB.');
  return { text, imageDataUrl: source, mimeType: match[1], base64: match[2] };
}

function requestForProvider(provider, secret, model, prompt) {
  const style = provider.apiStyle || 'openai-chat';
  const vision = typeof prompt === 'object' && prompt ? normalizeVisionInput(prompt) : null;
  const text = vision ? vision.text : String(prompt || '');
  const common = { 'content-type': 'application/json' };
  if (style === 'anthropic') return {
    url: `${provider.baseUrl}/messages`,
    headers: { ...common, ...(secret ? { 'x-api-key': secret } : {}), 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: provider.maxOutputTokens ?? 4096, messages: [{ role: 'user', content: vision ? [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: vision.mimeType, data: vision.base64 } }] : text }] }
  };
  if (style === 'google-gemini') return {
    url: `${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { ...common, ...(secret ? { 'x-goog-api-key': secret } : {}) },
    body: { contents: [{ role: 'user', parts: vision ? [{ text }, { inlineData: { mimeType: vision.mimeType, data: vision.base64 } }] : [{ text }] }], generationConfig: { maxOutputTokens: provider.maxOutputTokens ?? 4096 } }
  };
  if (style === 'openai-responses') return {
    url: `${provider.baseUrl}/responses`,
    headers: { ...common, ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: { model, input: vision ? [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: vision.imageDataUrl }] }] : text, ...(provider.maxOutputTokens === undefined ? {} : { max_output_tokens: provider.maxOutputTokens }) }
  };
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: { ...common, ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: { model, messages: [{ role: 'user', content: vision ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: vision.imageDataUrl } }] : text }], stream: false, ...(provider.maxOutputTokens === undefined ? {} : { max_tokens: provider.maxOutputTokens }) }
  };
}

function parseProviderResponse(provider, body) {
  const style = provider.apiStyle || 'openai-chat';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (style === 'anthropic') return {
    content: (body.content || []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n'),
    outputLimitReached: body.stop_reason === 'max_tokens',
    inputTokens: count(body.usage?.input_tokens), outputTokens: count(body.usage?.output_tokens)
  };
  if (style === 'google-gemini') return {
    content: (body.candidates?.[0]?.content?.parts || []).filter(item => typeof item?.text === 'string').map(item => item.text).join('\n'),
    outputLimitReached: body.candidates?.[0]?.finishReason === 'MAX_TOKENS',
    inputTokens: count(body.usageMetadata?.promptTokenCount), outputTokens: count(body.usageMetadata?.candidatesTokenCount)
  };
  if (style === 'openai-responses') return {
    content: typeof body.output_text === 'string' ? body.output_text : (body.output || []).flatMap(item => item?.content || []).filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n'),
    outputLimitReached: body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens',
    inputTokens: count(body.usage?.input_tokens), outputTokens: count(body.usage?.output_tokens)
  };
  const choice = body.choices?.[0];
  return { content: choice?.message?.content, outputLimitReached: choice?.finish_reason === 'length', inputTokens: count(body.usage?.prompt_tokens), outputTokens: count(body.usage?.completion_tokens) };
}

export async function completeWithProvider(provider, secret, model, prompt, { fetcher = fetch, signal, sleep = (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }), maxAttempts = 3 } = {}) {
  enforceInputContextLimit(provider, prompt);
  const request = requestForProvider(provider, secret, model, prompt);
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  let response;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    response = undefined;
    let retryable = false;
    try {
      response = await fetcher(request.url, {
        method: 'POST', redirect: 'error', signal: combinedSignal(signal, 120000),
        headers: request.headers,
        body: JSON.stringify(request.body)
      });
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403 ? 'Provider rejected the key or model permission.' : `Provider request failed (${response.status}).`);
        retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === attempts) throw error;
      } else break;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (response && !retryable) throw error;
      retryable = true;
      if (attempt === attempts) {
        if (error.message?.startsWith('Provider request failed')) throw error;
        throw new Error('The provider could not be reached. Check its address and connection.');
      }
    }
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    await sleep(Math.min(2000, 250 * (2 ** (attempt - 1))), signal);
  }
  const body = await response.json().catch(() => { throw new Error('Provider returned an unreadable response.'); });
  const parsed = parseProviderResponse(provider, body);
  const content = parsed.content;
  if (typeof content !== 'string' || !content.trim()) {
    if (parsed.outputLimitReached) throw new Error('This model reached its output-token limit before returning a visible answer. Increase the maximum output tokens in its connection settings, then try again.');
    throw new Error('Provider returned no text. Check that this model supports text chat and review its output-token settings.');
  }
  return { content, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens };
}

export async function testProviderConnection(provider, secret, { fetcher = fetch } = {}) {
  const style = provider.apiStyle || 'openai-chat';
  const headers = style === 'anthropic'
    ? { ...(secret ? { 'x-api-key': secret } : {}), 'anthropic-version': '2023-06-01' }
    : style === 'google-gemini'
      ? { ...(secret ? { 'x-goog-api-key': secret } : {}) }
      : { ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
  const response = await fetcher(`${provider.baseUrl}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => { throw new Error('Cannot reach the provider. Check the address and that the model service is running.'); });
  if (!response.ok && ![404, 405].includes(response.status)) throw new Error(response.status === 401 || response.status === 403 ? 'Provider rejected the saved key.' : `Provider returned HTTP ${response.status}.`);
  let models = [];
  if (response.ok) {
    const body = await response.json().catch(() => ({}));
    const values = provider.apiStyle === 'google-gemini' ? body.models : body.data;
    if (Array.isArray(values)) models = [...new Set(values.map((item) => String(item?.id || item?.name || '').replace(/^models\//, '').trim()).filter((model) => /^[^\s]{1,240}$/.test(model)))].slice(0, 200);
  }
  return { ok: true, status: response.status, models, message: response.ok ? (models.length ? `Provider is reachable and reported ${models.length} model${models.length === 1 ? '' : 's'}.` : 'Provider is reachable, but it did not report model IDs.') : 'Provider is reachable, but this API does not expose a model-list endpoint.' };
}

export async function generateImageWithProvider(provider, secret, model, prompt, { size = '1024x1024', fetcher = fetch } = {}) {
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) throw new Error('Choose a supported image size.');
  const response = await fetcher(`${provider.baseUrl}/images/generations`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300000),
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' })
  }).catch(() => { throw new Error('The image provider could not be reached.'); });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Image provider rejected the key or model permission.' : `Image generation failed (${response.status}).`);
  const body = await response.json().catch(() => { throw new Error('Image provider returned an unreadable response.'); });
  const item = body.data?.[0];
  if (typeof item?.b64_json === 'string' && item.b64_json.length) return { bytes: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png', revisedPrompt: item.revised_prompt || '' };
  if (typeof item?.url === 'string') {
    let url; try { url = new URL(item.url); } catch { throw new Error('Image provider returned an invalid result address.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Image provider returned an insecure result address.');
    const image = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120000) }).catch(() => { throw new Error('The generated image could not be downloaded.'); });
    const length = Number(image.headers.get('content-length') || 0);
    if (!image.ok || length > 20 * 1024 * 1024) throw new Error('The generated image could not be downloaded safely.');
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error('The generated image is larger than 20 MB.');
    const mimeType = (image.headers.get('content-type') || 'image/png').split(';')[0];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('The provider returned an unsupported image format.');
    return { bytes, mimeType, revisedPrompt: item.revised_prompt || '' };
  }
  throw new Error('Image provider returned no image.');
}
