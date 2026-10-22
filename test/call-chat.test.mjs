import assert from 'node:assert/strict';
import test from 'node:test';
import { recordCallChatTurn } from '../lib/call-chat.mjs';

test('spoken owner and agent turns share an ordinary retained Chat conversation', () => {
  const state = { rooms: [] };
  const connection = { id: 'link-a', agentId: 'agent-a', status: 'connected', identity: { name: 'Test agent' } };
  const call = { id: 'call-a', linkId: connection.id, status: 'active' };
  recordCallChatTurn(state, { connection, call, role: 'user', text: 'A spoken question.' });
  recordCallChatTurn(state, { connection, call, role: 'agent', text: 'A spoken answer.', turnKey: 'reply:1' });
  recordCallChatTurn(state, { connection, call, role: 'agent', text: 'A spoken answer.', turnKey: 'reply:1' });
  const persisted = JSON.parse(JSON.stringify(state));
  assert.equal(persisted.rooms.length, 1);
  assert.deepEqual(persisted.rooms[0].messages.map(m => m.role), ['user', 'agent']);
  assert.deepEqual(persisted.rooms[0].agentIds, ['agent-a']);
  assert.equal(recordCallChatTurn(state, { connection, call: { ...call, status: 'ended' }, role: 'user', text: 'Late.' }), null);
  assert.equal(recordCallChatTurn(state, { connection: { ...connection, id: 'other' }, call, role: 'user', text: 'Wrong Link.' }), null);
  assert.equal(recordCallChatTurn(state, { connection: { ...connection, status: 'revoked' }, call, role: 'user', text: 'Revoked.' }), null);
  assert.equal(state.rooms[0].messages.length, 2);
  recordCallChatTurn(state, { connection, call: { ...call, id: 'call-b' }, role: 'user', text: 'Another call.' });
  assert.equal(state.rooms.length, 2);
});
