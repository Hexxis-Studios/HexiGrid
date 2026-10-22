import test from 'node:test';
import assert from 'node:assert/strict';
import {
  queueAgentLinkEvent, readAgentLinkConversation, readAgentLinkConversationPage,
  receiveAgentLinkMessage
} from '../lib/agent-link.mjs';

function linked(id = 'link-history-qa') {
  return { id, status: 'connected', events: [], messages: [], nextSequence: 1 };
}

test('recent Link history pages exact text directions without control events or another Link', () => {
  const connection = linked();
  const owner = queueAgentLinkEvent(connection, { text: 'Owner exact text', metadata: { sender: 'owner' } });
  queueAgentLinkEvent(connection, { type: 'capabilities', text: 'Control event' });
  for (let index = 0; index < 125; index += 1) receiveAgentLinkMessage(connection, {
    clientMessageId: `history-client-${String(index).padStart(4, '0')}`, text: `Agent exact ${index}`
  });
  const codex = queueAgentLinkEvent(connection, { text: 'Codex exact text', metadata: { sender: 'Codex', channel: 'codex-thread' } });
  queueAgentLinkEvent(connection, { text: 'Unrelated message event', metadata: { sender: 'unknown' } });
  const all = [];
  let before;
  do {
    const page = readAgentLinkConversationPage(connection, { ...(before ? { before } : {}), limit: 40 });
    assert.equal(page.messages.length <= 40, true);
    all.unshift(...page.messages);
    before = page.nextCursor;
    if (!page.hasMore) break;
  } while (before);
  assert.equal(all.length, 127);
  assert.equal(all.some((message) => message.id === owner.id && message.direction === 'from-owner'), true);
  assert.equal(all.some((message) => message.id === codex.id && message.direction === 'from-codex'), true);
  assert.equal(all.some((message) => message.text === 'Control event' || message.text === 'Unrelated message event'), false);
  assert.equal(readAgentLinkConversation(connection).length, 100);
  const foreign = linked('link-other-qa');
  assert.throws(() => readAgentLinkConversationPage(foreign, { before: readAgentLinkConversationPage(connection, { limit: 1 }).nextCursor }), /another Link/);
});

test('recent Link history marks older text unavailable and rejects a trimmed cursor', () => {
  const connection = linked('link-trim-qa');
  for (let index = 0; index < 500; index += 1) receiveAgentLinkMessage(connection, {
    clientMessageId: `trim-client-${String(index).padStart(4, '0')}`, text: `Exact ${index}`
  });
  const oldPage = readAgentLinkConversationPage(connection, { limit: 100 });
  assert.equal(oldPage.olderUnavailable, false);
  const anchor = readAgentLinkConversationPage(connection, { limit: 100 }).nextCursor;
  for (let index = 500; index < 1001; index += 1) receiveAgentLinkMessage(connection, {
    clientMessageId: `trim-client-${String(index).padStart(4, '0')}`, text: `Exact ${index}`
  });
  assert.equal(readAgentLinkConversationPage(connection, { limit: 100 }).olderUnavailable, true);
  assert.throws(() => readAgentLinkConversationPage(connection, { before: anchor }), /trimmed/);
});
