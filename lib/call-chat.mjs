import { randomUUID } from 'node:crypto';

/** Calls are saved conversations in the existing local Chat store. No audio is retained. */
export function recordCallChatTurn(state, { connection, call, role, text, turnKey = '' } = {}) {
  if (call?.status !== 'active' || !connection || connection.status !== 'connected' || call.linkId !== connection.id ||
      !['user', 'agent'].includes(role) || !connection.agentId) return null;
  const content = String(text || '').trim().slice(0, 20_000);
  if (!content) return null;
  const createdAt = new Date().toISOString();
  state.rooms ||= [];
  let room = state.rooms.find(item => item.callId === call.id);
  if (!room) {
    room = { id: `room-${randomUUID()}`, name: `Call · ${connection.identity?.name || 'Agent'} · ${createdAt.slice(0, 10)}`,
      description: 'Voice call transcript saved on this device.', agentIds: [connection.agentId], messages: [],
      callId: call.id, callLinkId: connection.id, createdAt };
    state.rooms.push(room);
  }
  if (room.callLinkId !== connection.id) return null;
  if (turnKey && room.messages.some(item => item.callTurnKey === turnKey)) return room;
  room.messages.push({ id: `msg-${randomUUID()}`, role, agentId: role === 'agent' ? connection.agentId : null,
    author: role === 'agent' ? connection.identity?.name || 'Agent' : 'You', content, createdAt,
    source: 'voice-call', ...(turnKey ? { callTurnKey: turnKey } : {}) });
  return room;
}
