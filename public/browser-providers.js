(() => {
  const DIRECT_ERROR = 'DIRECT_BROWSER_UNAVAILABLE';

  function cleanUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the complete provider API address.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && location.protocol === 'http:')) throw new Error('Direct browser connections require HTTPS. Local HTTP works only from a local HTTP page.');
    if (url.username || url.password || url.hash) throw new Error('Do not put credentials or a fragment in the provider address.');
    return url.href.replace(/\/$/, '');
  }

  function headers(provider, secret, json = false) {
    const values = { accept: 'application/json' };
    if (json) values['content-type'] = 'application/json';
    if (provider.apiStyle === 'anthropic') {
      if (secret) values['x-api-key'] = secret;
      values['anthropic-version'] = '2023-06-01';
      values['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (provider.apiStyle === 'google-gemini') {
      if (secret) values['x-goog-api-key'] = secret;
    } else if (secret) values.authorization = `Bearer ${secret}`;
    return values;
  }

  async function requestJson(url, options, signalTimeout = 30000) {
    let response;
    try {
      const timeout = AbortSignal.timeout(signalTimeout);
      response = await fetch(url, { ...options, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = new Error(navigator.onLine === false
        ? 'This device is offline. Reconnect and try again.'
        : 'This provider did not allow the browser to connect directly, or its address could not be reached. Check the address first; if it is correct, use a provider-supported browser key, a user-owned relay, or a paired HexiGrid host.');
      failure.code = DIRECT_ERROR;
      failure.cause = error;
      throw failure;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403 ? 'The provider rejected this key or its permissions.' : `The provider returned HTTP ${response.status}. Check that provider's status page and API address, then try again.`);
    }
    return body;
  }

  function modelRecords(provider, body) {
    const items = provider.apiStyle === 'google-gemini' ? body.models : body.data;
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      const id = String(item?.id || item?.name || '').replace(/^models\//, '').trim();
      if (!id || /\s/.test(id) || id.length > 240) return null;
      return { id, label: String(item?.displayName || item?.name || item?.id || id).replace(/^models\//, '').slice(0, 240), pricing: item?.pricing || item?.cost || null };
    }).filter(Boolean).slice(0, 300);
  }

  async function discover(provider, secret) {
    const normalized = { ...provider, baseUrl: cleanUrl(provider.baseUrl) };
    const body = await requestJson(`${normalized.baseUrl}/models`, { headers: headers(normalized, secret) });
    const models = modelRecords(normalized, body);
    if (!models.length) throw new Error('The provider connected but did not return usable model IDs. Open Connection details and enter an exact model ID only if the provider documents it.');
    return { models, message: `Direct browser connection succeeded and reported ${models.length} model${models.length === 1 ? '' : 's'}.` };
  }

  function visionParts(content) {
    if (!Array.isArray(content)) return { text: String(content || ''), image: null };
    const text = content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n');
    const image = content.find((part) => part?.type === 'image_url')?.image_url?.url || null;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    if (image && !match) throw new Error('The attached frame must be a PNG, JPEG, or WebP image.');
    if (match && Math.floor(match[2].length * 3 / 4) > 1536 * 1024) throw new Error('The attached frame must be smaller than 1.5 MB.');
    return { text, image: match ? { url: image, mimeType: match[1], base64: match[2] } : null };
  }

  function estimateTextTokens(value) {
    return Math.ceil(String(value || '').length / 4);
  }

  function enforceInputContextLimit(provider, messages) {
    const limit = provider.maxInputTokens;
    if (limit === undefined) return;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000) throw new Error('Input-context token limit must be an integer from 1 to 1000000.');
    if (!Array.isArray(messages)) throw new Error('This request’s input context cannot be estimated safely.');
    const text = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') throw new Error('This request’s input context cannot be estimated safely.');
      if (typeof message.content === 'string') {
        text.push(message.content);
        continue;
      }
      if (!Array.isArray(message.content)) throw new Error('This request’s input context cannot be estimated safely.');
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
        else if (part?.type === 'image_url') throw new Error('The configured input-context token limit cannot be checked for image input with the available text-only estimate. Remove the image or clear this provider’s input-context limit.');
        else throw new Error('This request’s input context cannot be estimated safely.');
      }
    }
    const estimated = estimateTextTokens(text.join('\n'));
    if (estimated > limit) throw new Error(`Request exceeds this provider’s input-context limit (estimated ${estimated} tokens; limit ${limit}). Shorten the prompt or raise the configured limit.`);
  }

  function completionRequest(provider, secret, model, messages) {
    const baseUrl = cleanUrl(provider.baseUrl);
    const system = messages.filter((item) => item.role === 'system').map((item) => visionParts(item.content).text).join('\n\n');
    const conversation = messages.filter((item) => item.role !== 'system');
    if (provider.apiStyle === 'anthropic') return { url: `${baseUrl}/messages`, body: { model, max_tokens: provider.maxOutputTokens ?? 4096, system, messages: conversation.map((item) => { const parts = visionParts(item.content); return { role: item.role, content: parts.image ? [{ type: 'text', text: parts.text }, { type: 'image', source: { type: 'base64', media_type: parts.image.mimeType, data: parts.image.base64 } }] : parts.text }; }) } };
    if (provider.apiStyle === 'google-gemini') return { url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, body: { systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents: conversation.map((item) => { const parts = visionParts(item.content); return { role: item.role === 'assistant' ? 'model' : 'user', parts: parts.image ? [{ text: parts.text }, { inlineData: { mimeType: parts.image.mimeType, data: parts.image.base64 } }] : [{ text: parts.text }] }; }), generationConfig: { maxOutputTokens: provider.maxOutputTokens ?? 4096 } } };
    if (provider.apiStyle === 'openai-responses') return { url: `${baseUrl}/responses`, body: { model, instructions: system || undefined, input: conversation.map((item) => { const parts = visionParts(item.content); return { role: item.role, content: parts.image ? [{ type: 'input_text', text: parts.text }, { type: 'input_image', image_url: parts.image.url }] : parts.text }; }), ...(provider.maxOutputTokens === undefined ? {} : { max_output_tokens: provider.maxOutputTokens }) } };
    return { url: `${baseUrl}/chat/completions`, body: { model, messages, stream: false, ...(provider.maxOutputTokens === undefined ? {} : { max_tokens: provider.maxOutputTokens }) } };
  }

  function parseCompletion(provider, body) {
    if (provider.apiStyle === 'anthropic') return { content: (body.content || []).filter((item) => item?.type === 'text').map((item) => item.text).join('\n'), inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
    if (provider.apiStyle === 'google-gemini') return { content: (body.candidates?.[0]?.content?.parts || []).map((item) => item?.text || '').join('\n'), inputTokens: body.usageMetadata?.promptTokenCount, outputTokens: body.usageMetadata?.candidatesTokenCount };
    if (provider.apiStyle === 'openai-responses') return { content: body.output_text || (body.output || []).flatMap((item) => item?.content || []).filter((item) => item?.type === 'output_text').map((item) => item.text).join('\n'), inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
    return { content: body.choices?.[0]?.message?.content, inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens };
  }

  async function complete(provider, secret, model, messages, { signal } = {}) {
    enforceInputContextLimit(provider, messages);
    const request = completionRequest(provider, secret, model, messages);
    const body = await requestJson(request.url, { method: 'POST', signal, headers: headers(provider, secret, true), body: JSON.stringify(request.body) }, 120000);
    const result = parseCompletion(provider, body);
    if (typeof result.content !== 'string' || !result.content.trim()) throw new Error('The provider returned no text. Choose a chat-capable model.');
    return result;
  }

  async function speech(provider, secret, input) {
    const baseUrl = cleanUrl(provider.baseUrl);
    if (!['openai-chat', 'openai-responses'].includes(provider.apiStyle || 'openai-chat')) throw new Error('This speech connector requires an OpenAI-compatible audio/speech endpoint.');
    const model = String(input?.model || '').trim().slice(0, 240);
    const voice = String(input?.voice || '').trim().slice(0, 200);
    const text = String(input?.text || '').trim().slice(0, 12000);
    if (!model || !voice || !text) throw new Error('Choose a speech model and voice, then enter preview text.');
    let response;
    try {
      response = await fetch(`${baseUrl}/audio/speech`, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(180000), headers: headers(provider, secret, true), body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }) });
    } catch { throw new Error('This speech provider did not allow a direct browser request. Use the local HexiGrid host or a provider that permits browser calls.'); }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'The speech provider rejected this key or voice permission.' : `Speech generation failed (${response.status}).`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 20 * 1024 * 1024) throw new Error('The generated voice clip is larger than 20 MB.');
    const mimeType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].toLowerCase();
    if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4'].includes(mimeType)) throw new Error('The speech provider returned an unsupported audio format.');
    const audioBlob = await response.blob();
    if (!audioBlob.size || audioBlob.size > 20 * 1024 * 1024) throw new Error('The generated voice clip is empty or larger than 20 MB.');
    return { audioBlob, mimeType };
  }

  function usageBudgetFeedback(limit, records, now = Date.now()) {
    const configured = Number.isSafeInteger(limit) && limit > 0;
    const tokens = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    const start = now - 7 * 86400000;
    const used = (Array.isArray(records) ? records : []).filter(item => { const time = Date.parse(item.createdAt); return Number.isFinite(time) && time >= start && time <= now; })
      .reduce((sum, item) => sum + tokens(item.inputTokens) + tokens(item.outputTokens), 0);
    return { window: '7d', limit: configured ? limit : null, used, remaining: configured ? Math.max(0, limit - used) : null,
      flag: !configured ? 'unconfigured' : used >= limit ? 'exhausted' : used >= limit * 0.8 ? 'approaching' : 'under-budget' };
  }

  window.HexiGridBrowserProviders = Object.freeze({ DIRECT_ERROR, cleanUrl, discover, complete, speech, estimateTextTokens, usageBudgetFeedback });
})();
