import { createParser } from 'eventsource-parser';

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const messages = {
  invalid: 'The MCP server returned invalid JSON-RPC data.',
  missing: 'The MCP server did not return the expected JSON-RPC response.',
  oversized: 'The MCP server response exceeded the safe output limit.',
  stream: 'The MCP server response stream failed.',
};

function safeError(kind) {
  const error = new Error(messages[kind]);
  error.code = `MCP_HTTP_${kind.toUpperCase()}`;
  return error;
}

function validateMessage(value) {
  if (!plain(value) || value.jsonrpc !== '2.0') throw safeError('invalid');

  const hasId = Object.hasOwn(value, 'id');
  const hasMethod = Object.hasOwn(value, 'method');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (!hasId && hasMethod && !hasResult && !hasError && typeof value.method === 'string' && (!Object.hasOwn(value, 'params') || plain(value.params) || Array.isArray(value.params))) return null;

  if (!hasId || hasMethod || (value.id !== null && typeof value.id !== 'string' && (typeof value.id !== 'number' || !Number.isFinite(value.id))) || hasResult === hasError) throw safeError('invalid');
  if (hasError && (!plain(value.error) || typeof value.error.code !== 'number' || !Number.isFinite(value.error.code) || typeof value.error.message !== 'string')) throw safeError('invalid');
  return value;
}

function bytesOf(chunk) {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw safeError('stream');
}

function isAbortError(signal) {
  return signal?.reason?.name === 'TimeoutError'
    ? new Error('The MCP server timed out or was cancelled.')
    : new Error('The MCP request was cancelled.');
}

/** Read one bounded JSON or SSE response from an owned Node HTTP response. */
export async function readMcpHttpResponse(response, expectedId, { maxBytes = 1024 * 1024, signal } = {}) {
  const contentType = response.headers?.['content-type'] ?? response.headers?.get?.('content-type') ?? '';
  const isEventStream = String(contentType).split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
  const decoder = new TextDecoder();
  let size = 0;
  let decodedJson = '';
  let matched;
  let parserError;
  let destroyed = false;
  const destroyResponse = () => {
    if (destroyed) return;
    destroyed = true;
    try { response.destroy?.(); } catch {}
  };
  const onAbort = () => destroyResponse();
  const parser = isEventStream && expectedId !== undefined ? createParser({
    maxBufferSize: maxBytes,
    onError(error) {
      if (error?.type === 'max-buffer-size-exceeded') parserError = safeError('oversized');
    },
    onEvent(event) {
      if (matched || parserError || !event.data) return;
      try {
        const message = validateMessage(JSON.parse(event.data));
        if (message && message.id === expectedId) matched = message;
      } catch {
        parserError = safeError('invalid');
      }
    },
  }) : null;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer.');
  if (signal?.aborted) {
    destroyResponse();
    throw isAbortError(signal);
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw isAbortError(signal);
      const bytes = bytesOf(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) throw safeError('oversized');
      const text = decoder.decode(bytes, { stream: true });
      if (expectedId === undefined) continue;
      if (parser) {
        parser.feed(text);
        if (parserError) throw parserError;
        if (matched) {
          destroyResponse();
          break;
        }
      } else {
        decodedJson += text;
      }
    }
    if (signal?.aborted) throw isAbortError(signal);
    const tail = decoder.decode();
    if (expectedId === undefined) return null;
    if (parser) {
      parser.feed(tail);
      if (parserError) throw parserError;
      if (matched) return matched;
      throw safeError('missing');
    }
    let message;
    try { message = validateMessage(JSON.parse(decodedJson + tail)); } catch { throw safeError('invalid'); }
    if (!message || message.id !== expectedId) throw safeError('missing');
    return message;
  } catch (error) {
    destroyResponse();
    if (signal?.aborted) throw isAbortError(signal);
    if (typeof error?.code === 'string' && error.code.startsWith('MCP_HTTP_')) throw error;
    throw safeError('stream');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
