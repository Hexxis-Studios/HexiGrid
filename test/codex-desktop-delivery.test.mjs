import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runCodexDesktopTurn } from '../lib/codex-desktop-relay.mjs';
import { recoverCodexRelayDeliveries } from '../lib/codex-relay.mjs';

function desktop({ rejectSend = false } = {}) {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  child.stdin = { end() {}, write(raw) {
    const message = JSON.parse(raw); sent.push(message);
    if (!message.id) return;
    let payload = {};
    if (message.params?.name === 'read_thread') payload = { turns: [{ id: 'actual-caller-turn', status: 'inProgress' }] };
    if (message.params?.name === 'wait_threads') {
      const finished = message.params.arguments.targets[0].afterCursor === 'old-cursor';
      payload = { polls: [{ cursor: finished ? 'new-cursor' : 'old-cursor', thread: { id: 'thread-target-123' },
        latestTurn: { id: finished ? 'new-turn' : 'old-turn', status: 'completed' },
        latestAssistantMessage: { turnId: finished ? 'new-turn' : 'old-turn', phase: 'final_answer', text: finished ? 'new reply' : 'old reply' } }] };
    }
    const result = message.method === 'initialize' ? {} : { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: message.id,
      ...(rejectSend && message.params?.name === 'send_message_to_thread' ? { error: { message: 'synthetic failure' } } : { result }) }) + '\n'));
  } };
  return { sent, child };
}
function invoke(fixture, options) {
  return runCodexDesktopTurn({ threadId: 'thread-target-123', callerThreadId: 'thread-caller-123', prompt: 'disposable QA',
    serverPath: 'synthetic-server.mjs', spawnFn: () => fixture.child, timeoutMs: 1000, ...options });
}

test('acknowledged send provides a durable observation before watching reply', async () => {
  const fixture = desktop();
  let observation;
  const result = await invoke(fixture, { onSubmitted(value) {
    observation = value;
    assert.equal(fixture.sent.filter(item => item.params?.name === 'wait_threads').length, 1);
  } });
  assert.equal(result.content, 'new reply');
  const send = fixture.sent.find(item => item.params?.name === 'send_message_to_thread');
  assert.equal(send.params._meta['openai/turnId'], 'actual-caller-turn');
  assert.match(send.params._meta['openai/toolCallId'], /^hexigrid-/);
  assert.notEqual(send.params._meta['openai/toolCallId'], fixture.sent.find(item => item.params?.name === 'wait_threads').params._meta['openai/toolCallId']);
  assert.deepEqual(observation, { threadId: 'thread-target-123', sameThread: false, previousTurn: 'old-turn', previousTurnActive: false, cursor: 'old-cursor' });
});

test('restored observation watches the original reply and never resends', async () => {
  const fixture = desktop();
  const result = await invoke(fixture, { resumeObservation: { threadId: 'thread-target-123', sameThread: false,
    previousTurn: 'old-turn', previousTurnActive: false, cursor: 'old-cursor' } });
  assert.equal(result.content, 'new reply');
  assert.equal(fixture.sent.some(item => item.params?.name === 'send_message_to_thread'), false);
});

test('revocation at dispatch sends nothing and marks not-submitted', async () => {
  const fixture = desktop();
  await assert.rejects(invoke(fixture, { assertAuthorized() { throw new Error('revoked'); } }),
    error => error.codexDeliveryStatus === 'not-submitted');
  assert.equal(fixture.sent.some(item => item.params?.name === 'send_message_to_thread'), false);
});

test('lost acknowledgement is uncertain while a save failure retains confirmed observation', async () => {
  await assert.rejects(invoke(desktop({ rejectSend: true })), error => error.codexDeliveryStatus === 'uncertain');
  await assert.rejects(invoke(desktop(), { onSubmitted() { throw new Error('synthetic save failure'); } }),
    error => error.codexDeliveryStatus === 'submitted' && error.codexObservation?.previousTurn === 'old-turn');
});

test('restart recovery resumes acknowledged observation and holds uncertain intent', () => {
  const jobs = [{ id: 'unknown', delivery: 'submitting' },
    { id: 'acknowledged', delivery: 'submitting', observation: { threadId: 'thread-target-123' } },
    { id: 'queued' }];
  recoverCodexRelayDeliveries(jobs);
  assert.equal(jobs[0].delivery, 'delivery-uncertain');
  assert.equal(jobs[1].delivery, 'awaiting-reply');
  assert.equal(jobs[2].delivery, undefined);
  recoverCodexRelayDeliveries(jobs);
  assert.equal(jobs[0].delivery, 'delivery-uncertain');
});
