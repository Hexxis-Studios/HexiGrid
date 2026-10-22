import crypto from 'node:crypto';

export const HEXISPACE_CONVERSATION_LIMIT = 100;
export const HEXISPACE_MESSAGE_LIMIT = 50000;
export const HEXISPACE_CONTEXT_LIMIT = 64000;

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function normalizeMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
  const createdAt = typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt))
    ? message.createdAt.slice(0, 40)
    : new Date().toISOString();
  return {
    id: clean(message.id, 120) || `hv-message-${crypto.randomUUID()}`,
    role: message.role,
    content: message.content.replace(/\0/g, '').slice(0, HEXISPACE_MESSAGE_LIMIT),
    createdAt
  };
}

/** Normalize private, local-only HexiSpace bridge conversations in encrypted HexiGrid state. */
export function normalizeHexiSpaceConversations(state) {
  state.hexispace = state.hexispace && typeof state.hexispace === 'object' ? state.hexispace : {};
  const rows = Array.isArray(state.hexispace.conversations) ? state.hexispace.conversations : [];
  const normalized = new Map();
  for (const row of rows) {
    const linkId = clean(row?.linkId, 200);
    const agentId = clean(row?.agentId, 120);
    if (!linkId || !agentId) continue;
    const messages = (Array.isArray(row.messages) ? row.messages : [])
      .map(normalizeMessage).filter(Boolean).slice(-HEXISPACE_CONVERSATION_LIMIT);
    const key = `${linkId}\0${agentId}`;
    const previous = normalized.get(key);
    normalized.set(key, {
      linkId,
      agentId,
      messages: previous ? [...previous.messages, ...messages].slice(-HEXISPACE_CONVERSATION_LIMIT) : messages,
      updatedAt: typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt))
        ? row.updatedAt.slice(0, 40)
        : messages.at(-1)?.createdAt || new Date().toISOString()
    });
  }
  state.hexispace.conversations = [...normalized.values()];
  return state.hexispace.conversations;
}

export function getHexiSpaceConversation(state, linkId, agentId) {
  const linkKey = clean(linkId, 200);
  const agentKey = clean(agentId, 120);
  const row = normalizeHexiSpaceConversations(state).find((item) => item.linkId === linkKey && item.agentId === agentKey);
  return { agentId: agentKey, messages: row ? row.messages.map((message) => ({ ...message })) : [] };
}

export function appendHexiSpaceConversationMessage(state, linkId, agentId, message) {
  const linkKey = clean(linkId, 200);
  const agentKey = clean(agentId, 120);
  const normalizedMessage = normalizeMessage(message);
  if (!linkKey || !agentKey || !normalizedMessage) throw new TypeError('A linked account, agent, and valid conversation message are required.');
  const rows = normalizeHexiSpaceConversations(state);
  let row = rows.find((item) => item.linkId === linkKey && item.agentId === agentKey);
  if (!row) {
    row = { linkId: linkKey, agentId: agentKey, messages: [], updatedAt: normalizedMessage.createdAt };
    rows.push(row);
  }
  row.messages.push(normalizedMessage);
  row.messages = row.messages.slice(-HEXISPACE_CONVERSATION_LIMIT);
  row.updatedAt = normalizedMessage.createdAt;
  return { agentId: agentKey, messages: row.messages.map((item) => ({ ...item })) };
}

export function clearHexiSpaceConversation(state, linkId, agentId) {
  const linkKey = clean(linkId, 200);
  const agentKey = clean(agentId, 120);
  const rows = normalizeHexiSpaceConversations(state);
  const existing = rows.find((item) => item.linkId === linkKey && item.agentId === agentKey);
  state.hexispace.conversations = rows.filter((item) => item.linkId !== linkKey || item.agentId !== agentKey);
  return existing?.messages.length || 0;
}

/** Keep the most recent complete messages inside a bounded model-context payload. */
export function formatHexiSpaceConversationContext(messages, maxCharacters = HEXISPACE_CONTEXT_LIMIT) {
  const limit = Math.max(1024, Math.min(HEXISPACE_CONTEXT_LIMIT, Number(maxCharacters) || HEXISPACE_CONTEXT_LIMIT));
  const selected = [];
  let size = 2;
  for (const message of [...(Array.isArray(messages) ? messages : [])].slice(-HEXISPACE_CONVERSATION_LIMIT).reverse()) {
    const item = { role: message?.role === 'assistant' ? 'assistant' : 'user', content: String(message?.content || '').slice(0, HEXISPACE_MESSAGE_LIMIT) };
    const itemSize = JSON.stringify(item).length + (selected.length ? 1 : 0);
    if (selected.length && size + itemSize > limit) break;
    selected.push(item);
    size += itemSize;
  }
  return JSON.stringify(selected.reverse());
}
