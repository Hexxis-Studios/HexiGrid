import crypto from 'node:crypto';
import { queueAgentLinkEvent } from './agent-link.mjs';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export function queueLinkedRoomTurn({ room, connection, agent, requestId, transcript, ownerMessageId }) {
  if (!room || room.archived || !room.agentIds.includes(agent.id)) fail('This agent is not a current responder in this room.');
  if (connection?.status !== 'connected' || connection.agentId !== agent.id || !connection.capabilities.includes('messages')) fail('This paired Link cannot receive room messages.', 403);
  if (!ownerMessageId || !room.messages.some(message => message.id === ownerMessageId && message.role === 'user')) fail('A saved owner message is required.');
  const prior = room.messages.find(message => message.linkedTurn?.ownerMessageId === ownerMessageId && message.linkedTurn.linkId === connection.id);
  if (prior) return prior;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const event = queueAgentLinkEvent(connection, { type:'room-message', text:String(transcript).slice(-48000),
    metadata:{ roomId:room.id, roomName:room.name, requestId, ownerMessageId, expiresAt } });
  const message = { id:`msg-${crypto.randomUUID()}`, role:'system', agentId:agent.id, author:agent.name,
    content:'Message queued through the paired Link. Waiting for the external agent to reply.', delivery:'queued-link', createdAt:new Date().toISOString(),
    linkedTurn:{ linkId:connection.id, eventId:event.id, ownerMessageId, requestId, expiresAt, status:'queued' } };
  room.messages.push(message);
  return message;
}

export function acceptLinkedRoomReply({ rooms, connection, agent, body }) {
  if (connection?.status !== 'connected' || !connection.capabilities.includes('messages') || agent?.id !== connection.agentId) fail('This Link cannot reply to room messages.',403);
  const room = rooms.find(item => item.id === body.roomId);
  if (!room || room.archived || !room.agentIds.includes(connection.agentId)) fail('This room is unavailable to this Link.',403);
  const pending = room.messages.find(message => message.linkedTurn?.eventId === body.eventId && message.linkedTurn.linkId === connection.id);
  if (!pending) fail('This room request is unavailable to this Link.',403);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 50000) fail('Provide a non-empty room reply of at most 50,000 characters.',400);
  if (pending.linkedTurn.status === 'completed') {
    const prior = room.messages.find(message => message.inReplyTo === pending.id);
    if (!prior || prior.content !== text) fail('This room request already has a different reply.');
    return { message:prior, duplicate:true };
  }
  if (pending.linkedTurn.status !== 'queued' || Date.parse(pending.linkedTurn.expiresAt) <= Date.now()) fail('This room request was cancelled or expired.');
  const message = { id:`msg-${crypto.randomUUID()}`, role:'agent', agentId:connection.agentId, author:agent.name,
    content:text, transport:'agent-link', delivery:'signed-link', inReplyTo:pending.id, createdAt:new Date().toISOString() };
  room.messages.push(message);
  pending.linkedTurn.status='completed'; pending.delivery='completed-link'; pending.content='The external agent replied through the paired Link.';
  return { message, duplicate:false };
}
