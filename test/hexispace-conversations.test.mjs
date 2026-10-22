import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHexiSpaceConversationMessage, clearHexiSpaceConversation, formatHexiSpaceConversationContext, getHexiSpaceConversation, HEXISPACE_CONVERSATION_LIMIT, normalizeHexiSpaceConversations } from '../lib/hexispace-conversations.mjs';

test('conversation rows retain only scoped, bounded message fields', () => {
  const state = { hexispace: { conversations: [{
    linkId: 'link-a', agentId: 'agent-a', ownerSecret: 'must-not-survive', updatedAt: '2026-09-17T12:00:00.000Z',
    messages: [
      { id: 'user-1', role: 'user', content: 'Hello', createdAt: '2026-09-17T11:59:00.000Z', apiKey: 'secret' },
      { id: 'invalid', role: 'system', content: 'not a chat turn', createdAt: '2026-09-17T11:59:30.000Z' }
    ]
  }] } };

  const rows = normalizeHexiSpaceConversations(state);
  assert.deepEqual(rows, [{ linkId: 'link-a', agentId: 'agent-a', updatedAt: '2026-09-17T12:00:00.000Z', messages: [{ id: 'user-1', role: 'user', content: 'Hello', createdAt: '2026-09-17T11:59:00.000Z' }] }]);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
  assert.equal(JSON.stringify(rows).includes('ownerSecret'), false);
});

test('conversation history is isolated by connector link and agent and capped to the newest turns', () => {
  const state = { hexispace: {} };
  for (let index = 0; index < HEXISPACE_CONVERSATION_LIMIT + 3; index += 1) {
    appendHexiSpaceConversationMessage(state, 'link-a', 'agent-a', { role: index % 2 ? 'assistant' : 'user', content: `turn-${index}` });
  }
  appendHexiSpaceConversationMessage(state, 'link-b', 'agent-a', { role: 'user', content: 'private to link B' });
  appendHexiSpaceConversationMessage(state, 'link-a', 'agent-b', { role: 'user', content: 'private to agent B' });

  const conversation = getHexiSpaceConversation(state, 'link-a', 'agent-a');
  assert.equal(conversation.messages.length, HEXISPACE_CONVERSATION_LIMIT);
  assert.equal(conversation.messages[0].content, 'turn-3');
  assert.equal(conversation.messages.at(-1).content, 'turn-102');
  assert.deepEqual(getHexiSpaceConversation(state, 'link-b', 'agent-a').messages.map((item) => item.content), ['private to link B']);
  assert.deepEqual(getHexiSpaceConversation(state, 'link-a', 'agent-b').messages.map((item) => item.content), ['private to agent B']);
});

test('model context stays within its bound and keeps the newest complete messages in order', () => {
  const entries = [
    { role: 'user', content: 'old'.repeat(30000) },
    { role: 'assistant', content: 'middle' },
    { role: 'user', content: 'latest' }
  ];
  const context = formatHexiSpaceConversationContext(entries, 1024);
  assert.ok(context.length <= 1024);
  assert.deepEqual(JSON.parse(context), [entries[1], entries[2]]);
});

test('clearing one linked thread leaves other browser and agent conversations intact', () => {
  const state = { hexispace: {} };
  appendHexiSpaceConversationMessage(state, 'link-a', 'agent-a', { role: 'user', content: 'remove this thread' });
  appendHexiSpaceConversationMessage(state, 'link-b', 'agent-a', { role: 'user', content: 'keep link B' });
  appendHexiSpaceConversationMessage(state, 'link-a', 'agent-b', { role: 'user', content: 'keep agent B' });

  assert.equal(clearHexiSpaceConversation(state, 'link-a', 'agent-a'), 1);
  assert.deepEqual(getHexiSpaceConversation(state, 'link-a', 'agent-a').messages, []);
  assert.equal(getHexiSpaceConversation(state, 'link-b', 'agent-a').messages[0].content, 'keep link B');
  assert.equal(getHexiSpaceConversation(state, 'link-a', 'agent-b').messages[0].content, 'keep agent B');
});
