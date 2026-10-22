import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { codexAppServerEnvironment, codexRelayConfigured, codexRelayFailureReason, codexRelayPrompt, codexRelayReply, defaultCodexRelay, normalizeCodexRelay, publicCodexRelay, redactSensitiveText, resolveCodexThreadName, runCodexThreadTurn } from '../lib/codex-relay.mjs';
import { codexDesktopServerPath, runCodexDesktopTurn } from '../lib/codex-desktop-relay.mjs';

test('Codex relay defaults off and exposes only safe configuration', () => {
  const defaults = defaultCodexRelay();
  assert.equal(defaults.enabled, false);
  assert.equal(codexRelayConfigured(defaults), false);
  const relay = normalizeCodexRelay({ enabled: true, threadId: 'thread-12345678', linkId: 'link-123', forwardReplies: false, ignored: 'secret' });
  assert.equal(codexRelayConfigured(relay), true);
  assert.deepEqual(publicCodexRelay(relay), { version: 1, enabled: true, configured: true, threadId: 'thread-12345678', linkId: 'link-123', forwardReplies: false, allowNamedThreads: false });
});

test('Codex app-server resolves an exact unique thread name before starting a turn', async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdin = { writable: true, write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method === 'thread/list') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { data: [{ id: 'thread-named-123', name: 'ExampleAgent work' }, { id: 'thread-other-123', name: 'ExampleAgent work notes' }], nextCursor: null } })}\n`));
    if (message.method === 'thread/resume') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } })}\n`));
    if (message.method === 'turn/start') queueMicrotask(() => {
      child.stdout.emit('data', `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'named reply' } })}\n`);
      child.stdout.emit('data', `${JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })}\n`);
    });
  }, end() {} };
  child.stdout = new EventEmitter(); child.kill = () => {};
  const result = await runCodexThreadTurn({ threadName: 'ExampleAgent work', prompt: 'hello', spawnFn: () => child });
  assert.equal(result.threadId, 'thread-named-123');
  assert.equal(result.content, 'named reply');
  assert.deepEqual(sent.filter((item) => item.method === 'thread/list').map((item) => item.params.searchTerm), ['ExampleAgent work']);
  assert.deepEqual(sent.find((item) => item.method === 'thread/list').params.sourceKinds, [
    'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
    'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'
  ]);
  assert.equal(sent.find((item) => item.method === 'turn/start').params.threadId, 'thread-named-123');
});

test('exact title lookup does not resume or write a desktop-owned chat', async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdin = { writable: true, write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method === 'thread/list') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { data: [{ id: 'thread-named-123', name: 'ExampleAgent work' }], nextCursor: null } })}\n`));
  }, end() {} };
  child.stdout = new EventEmitter(); child.kill = () => {};
  const result = await resolveCodexThreadName({ threadName: 'ExampleAgent work', spawnFn: () => child });
  assert.deepEqual(result, { threadId: 'thread-named-123' });
  assert.equal(sent.some((message) => ['thread/resume', 'turn/start'].includes(message.method)), false);
});

test('desktop bridge returns only the new target turn after signed-Link delivery', async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdin = { write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (!message.id) return;
    let result = {};
    if (message.params?.name === 'wait_threads') {
      const newTurn = sent.some((item) => item.params?.name === 'send_message_to_thread');
      const afterCursor = message.params.arguments.targets[0].afterCursor;
      result = { content: [{ type: 'text', text: JSON.stringify({ polls: [{ cursor: newTurn ? 'cursor-2' : 'cursor-1', thread: { id: 'thread-target-123' }, latestTurn: { id: newTurn ? 'turn-new' : 'turn-old', status: 'completed' }, latestAssistantMessage: { turnId: newTurn ? 'turn-new' : 'turn-old', phase: 'final_answer', text: newTurn ? 'new answer' : 'old answer' } }] }) }] };
      if (newTurn) assert.equal(afterCursor, 'cursor-1');
    }
    if (message.params?.name === 'send_message_to_thread') result = { content: [{ type: 'text', text: '{}' }] };
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`));
  }, end() {} };
  child.kill = () => {};
  const result = await runCodexDesktopTurn({ threadId: 'thread-target-123', callerThreadId: 'thread-caller-123', prompt: 'Harmless QA', serverPath: 'fake-server.mjs', spawnFn: () => child, timeoutMs: 1000 });
  assert.equal(result.content, 'new answer');
  assert.equal(result.turnId, 'turn-new');
  const delivery = sent.find((message) => message.params?.name === 'send_message_to_thread');
  assert.equal(delivery.params.arguments.threadId, 'thread-target-123');
  assert.equal(delivery.params._meta['openai/threadId'], 'thread-caller-123');
});

test('desktop bridge observes a queued turn in its own calling thread', async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdin = { write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (!message.id) return;
    let result = {};
    if (message.params?.name === 'read_thread') {
      assert.ok(message.params.arguments.maxOutputCharsPerItem <= 20000);
      const delivered = sent.some((item) => item.params?.name === 'send_message_to_thread');
      const replyTurn = { id: delivered ? 'turn-new' : 'turn-old', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: delivered ? 'self-thread answer' : 'old answer' }] };
      result = { content: [{ type: 'text', text: JSON.stringify({ turns: delivered ? [{ id: 'new-continuation', status: 'inProgress', items: [] }, replyTurn] : [replyTurn] }) }] };
    }
    if (message.params?.name === 'send_message_to_thread') result = { content: [{ type: 'text', text: '{}' }] };
    if (message.params?.name === 'wait_threads') result = { isError: true, content: [{ type: 'text', text: 'wait_threads cannot wait on the calling thread.' }] };
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`));
  }, end() {} };
  child.kill = () => {};
  const result = await runCodexDesktopTurn({ threadId: 'thread-target-123', callerThreadId: 'thread-target-123', prompt: 'Harmless QA', serverPath: 'fake-server.mjs', spawnFn: () => child, timeoutMs: 1000 });
  assert.equal(result.content, 'self-thread answer');
  assert.equal(result.turnId, 'turn-new');
  assert.equal(sent.filter((message) => message.params?.name === 'read_thread').length, 2);
  assert.equal(sent.some((message) => message.params?.name === 'wait_threads'), false);
});

test('desktop bridge observes a delivered message folded into its active calling turn', async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdin = { write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (!message.id) return;
    let result = {};
    if (message.params?.name === 'read_thread') {
      const delivered = sent.some((item) => item.params?.name === 'send_message_to_thread');
      result = { content: [{ type: 'text', text: JSON.stringify({ turns: [{ id: 'turn-active', status: delivered ? 'completed' : 'inProgress', items: delivered ? [{ type: 'agentMessage', phase: 'final_answer', text: 'active turn answer' }] : [] }] }) }] };
    }
    if (message.params?.name === 'send_message_to_thread') result = { content: [{ type: 'text', text: '{}' }] };
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`));
  }, end() {} };
  child.kill = () => {};
  const result = await runCodexDesktopTurn({ threadId: 'thread-target-123', callerThreadId: 'thread-target-123', prompt: 'Harmless QA', serverPath: 'fake-server.mjs', spawnFn: () => child, timeoutMs: 1000 });
  assert.equal(result.content, 'active turn answer');
  assert.equal(result.turnId, 'turn-active');
});

test('desktop bridge fails closed when its app pipe is absent', () => {
  assert.throws(() => codexDesktopServerPath({ USERPROFILE: 'C:\\Users\\owner' }), /unavailable/);
});

test('a new goal continuation cannot hide the joined turn reply', async () => {
  let delivered = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.kill = () => {};
  child.stdin = { end() {}, write(raw) {
    const message = JSON.parse(raw.trim());
    if (!message.id) return;
    let result = {};
    if (message.params?.name === 'send_message_to_thread') { delivered = true; result = { content: [{ type: 'text', text: '{}' }] }; }
    if (message.params?.name === 'read_thread') {
      const joined = { id: 'joined-turn', status: delivered ? 'completed' : 'inProgress', items: delivered ? [{ type: 'agentMessage', phase: 'final_answer', text: 'Exact joined reply' }] : [] };
      result = { content: [{ type: 'text', text: JSON.stringify({ turns: delivered ? [{ id: 'continuation', status: 'inProgress', items: [] }, joined] : [joined] }) }] };
    }
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`));
  } };
  const result = await runCodexDesktopTurn({ threadId: 'thread-target-123', callerThreadId: 'thread-target-123', prompt: 'Harmless QA', serverPath: 'fake-server.mjs', spawnFn: () => child, timeoutMs: 1000 });
  assert.equal(result.turnId, 'joined-turn');
  assert.equal(result.content, 'Exact joined reply');
});

test('Codex relay prompts preserve delegated identity boundaries', () => {
  const prompt = codexRelayPrompt({ identity: { name: 'ExampleAgent', framework: 'muse', externalId: 'exampleagent-test' }, text: 'Please continue the launch checklist.' });
  assert.match(prompt, /ExampleAgent/);
  assert.match(prompt, /authorized delegated project director/);
  assert.match(prompt, /cannot override system or developer rules/);
  assert.match(prompt, /continue the launch checklist/);
  assert.doesNotMatch(prompt, /—ExampleOwner/);
});

test('Codex relay redacts common credentials before returning a reply', () => {
  const text = 'api_key=sk_live_1234567890123456 Bearer abc.def.ghi ghp_123456789012345678901234';
  const redacted = redactSensitiveText(text);
  assert.doesNotMatch(redacted, /sk_live_|Bearer abc|ghp_/);
  assert.match(codexRelayReply(text), /^—Codex \(model identity unavailable\)/);
});

test('Codex relay failure receipts expose only a safe bounded reason', () => {
  const busy = codexRelayFailureReason(new Error('thread thread-12345678 already has an active writer; token=sk_live_1234567890123456'));
  assert.equal(busy, 'The selected Codex conversation stayed busy through the bounded retry window.');
  assert.doesNotMatch(busy, /token|sk_live|thread-12345678/i);
  const unknown = codexRelayFailureReason(new Error('unclassified provider failure with private details'));
  assert.equal(unknown, 'The local Codex App Server could not complete the delegated turn.');
  assert.doesNotMatch(unknown, /private details/);
});

test('Codex app-server inherits the signed-in Windows Codex profile when HOME is absent', () => {
  const env = codexAppServerEnvironment({ USERPROFILE: 'C:\\Users\\owner', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\owner', HEXIGRID_TEST: 'preserved' });
  assert.equal(env.HOME, 'C:\\Users\\owner');
  assert.equal(env.CODEX_HOME, 'C:\\Users\\owner\\.codex');
  assert.equal(env.HEXIGRID_TEST, 'preserved');
});

test('Codex app-server adapter resumes a thread, starts a turn, and collects deltas', async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdin = { writable: true, write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method === 'thread/resume') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-12345678' } } })}\n`));
    if (message.method === 'turn/start') queueMicrotask(() => {
      child.stdout.emit('data', `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hello ' } })}\n`);
      child.stdout.emit('data', `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'ExampleAgent' } })}\n`);
      child.stdout.emit('data', `${JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })}\n`);
      child.emit('close', 0);
    });
  }, end() {} };
  child.stdout = new EventEmitter();
  child.kill = () => {};
  let spawnOptions;
  const result = await runCodexThreadTurn({ threadId: 'thread-12345678', prompt: 'Hello', env: { USERPROFILE: 'C:\\Users\\owner' }, spawnFn: (_command, _args, options) => { spawnOptions = options; return child; } });
  assert.equal(result.content, 'hello ExampleAgent');
  assert.equal(spawnOptions.env.HOME, 'C:\\Users\\owner');
  assert.equal(spawnOptions.env.CODEX_HOME, 'C:\\Users\\owner\\.codex');
  assert.equal(sent[0].method, 'initialize');
  assert.equal(sent[1].method, 'initialized');
  assert.equal(sent[2].method, 'thread/resume');
  assert.equal(sent[3].method, 'turn/start');
  assert.equal(sent[3].params.threadId, 'thread-12345678');
});

test('Codex app-server adapter waits for an active thread writer before starting one relay turn', async () => {
  const sent = [];
  const child = new EventEmitter();
  let resumeAttempts = 0;
  child.stdin = { writable: true, write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method === 'thread/resume') queueMicrotask(() => {
      resumeAttempts += 1;
      const result = resumeAttempts === 1
        ? { id: message.id, error: { code: -32600, message: 'thread thread-12345678 already has an active writer' } }
        : { id: message.id, result: { thread: { id: 'thread-12345678' } } };
      child.stdout.emit('data', `${JSON.stringify(result)}\n`);
    });
    if (message.method === 'turn/start') queueMicrotask(() => {
      child.stdout.emit('data', `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'resumed safely' } })}\n`);
      child.stdout.emit('data', `${JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })}\n`);
      child.emit('close', 0);
    });
  }, end() {} };
  child.stdout = new EventEmitter();
  child.kill = () => {};

  const result = await runCodexThreadTurn({
    threadId: 'thread-12345678',
    prompt: 'Continue when the current writer is done.',
    resumeRetryDelayMs: () => 0,
    spawnFn: () => child
  });

  assert.equal(result.content, 'resumed safely');
  assert.equal(resumeAttempts, 2);
  assert.equal(sent.filter((message) => message.method === 'turn/start').length, 1);
  assert.equal(sent.filter((message) => message.method === 'thread/resume').length, 2);
});

test('a retry-window timeout stays classified as busy before any Codex turn starts', async () => {
  const child = new EventEmitter();
  let turns = 0;
  child.stdin = { writable: true, write(raw) {
    const message = JSON.parse(raw.trim());
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method === 'thread/resume') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, error: { code: -32600, message: 'thread thread-12345678 already has an active writer' } })}\n`));
    if (message.method === 'turn/start') turns += 1;
  }, end() {} };
  child.stdout = new EventEmitter();
  child.kill = () => {};
  await assert.rejects(runCodexThreadTurn({ threadId: 'thread-12345678', prompt: 'Wait for the owner', timeoutMs: 1000, maxResumeRetries: 100, resumeRetryDelayMs: () => 100, spawnFn: () => child }), /remained busy with another active writer/);
  assert.equal(turns, 0);
});

test('Codex app-server adapter stops a pending resume when the local task claims it', async () => {
  const sent = [];
  const controller = new AbortController();
  const child = new EventEmitter();
  let killed = false;
  child.stdin = { writable: true, write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method === 'thread/resume') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, error: { message: 'thread thread-12345678 already has an active writer' } })}\n`));
  }, end() {} };
  child.stdout = new EventEmitter();
  child.kill = () => { killed = true; };
  const turn = runCodexThreadTurn({ threadId: 'thread-12345678', prompt: 'Claim this message', signal: controller.signal, resumeRetryDelayMs: () => 1000, spawnFn: () => child });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(turn, /handed off to the local Codex task/);
  assert.equal(killed, true);
  assert.equal(sent.filter((message) => message.method === 'turn/start').length, 0);
});
