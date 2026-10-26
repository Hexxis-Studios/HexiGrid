import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { codexRelayForLink, codexRelayConfigured, codexApprovedChats } from '../lib/codex-relay.mjs';

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain available in server.mjs`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('Codex relay dispatches queued turns FIFO without awaiting earlier completion', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const implementation = extractFunction(source, 'startCodexRelayDrain');
  const pending = ['first', 'second'].map((id) => ({ id, linkId: 'link', threadId: 'thread', text: id, identity: {}, delivery: 'codex-relay' }));
  const started = [];
  const replies = [];
  let releaseFirst;
  const firstTurn = new Promise((resolve) => { releaseFirst = resolve; });
  let running = false;
  const currentState = { settings: { codexRelay: { enabled: true, linkId: 'link', threadId: 'thread', forwardReplies: true } }, codexRelayPending: pending, agentLinks: [{ id: 'link', status: 'connected', agentId: 'agent', trustLevel: 'owner', identity: { name: 'Agent' } }] };
  const drain = new Function('state', 'codexRelayRunning', 'shuttingDown', 'codexRelayForLink', 'codexRelayJobAuthorized', 'connectorPolicy', 'codexRelayPrompt', 'codexDesktopEnvironment', 'harnessCommand', 'resolveCodexThreadName', 'runCodexDesktopTurn', 'codexRelayAttempts', 'queueAgentLinkEvent', 'addReceipt', 'saveState', 'addActivity', 'ROOT', 'codexRelayReply', 'codexRelayFailureReason', 'codexRelayRetryTimer', `return (${implementation});`) (
    currentState, running, false,
    relay => relay,
    (job, relay, connection) => Boolean(connection && relay.enabled && relay.linkId === job.linkId && relay.threadId === job.threadId),
    () => null,
    ({ text }) => text,
    async () => ({ threadId: 'thread' }),
    () => ({ command: 'codex', prefixArgs: [] }),
    async () => ({}),
    async ({ prompt, onSubmitted }) => { started.push(prompt); await onSubmitted({ threadId: 'thread' }); return prompt === 'first' ? firstTurn : { content: 'reply second', threadId: 'thread' }; },
    new Map(),
    (_connection, event) => replies.push(event),
    () => {}, async () => {}, () => {}, process.cwd(), (text) => text, (error) => error.message, {}
  );
  drain();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(currentState.codexRelayPending.length, 1, 'uncompleted delivery remains durable');
  for (let i = 0; i < 10 && replies.length < 1; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies.map((event) => event.metadata.sourceMessageId), ['second']);
  releaseFirst({ content: 'reply first', threadId: 'thread' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies.map((event) => event.metadata.sourceMessageId), ['second', 'first']);
});

async function harness(run, jobs = [{ id: 'first', linkId: 'link', threadId: 'thread', text: 'first', identity: {} }]) {
  const implementation = extractFunction(await readFile(new URL('../server.mjs', import.meta.url), 'utf8'), 'startCodexRelayDrain');
  const state = { settings: { codexRelay: { enabled: true, linkId: 'link', threadId: 'thread', forwardReplies: true } },
    codexRelayPending: jobs, agentLinks: [{ id: 'link', tokenHash: 'synthetic-hash', status: 'connected', agentId: 'agent', identity: { name: 'Agent' } }] };
  const saved = [];
  const replies = [];
  let retries = 0;
  const dependencies = { state, codexRelayRunning: false, shuttingDown: false,
    codexRelayForLink: value => value,
    codexRelayJobAuthorized: (job, relay, connection) => Boolean(connection && relay.enabled && relay.linkId === job.linkId),
    connectorPolicy: () => null, codexRelayPrompt: ({ text }) => text,
    codexDesktopEnvironment: async () => ({}), harnessCommand: () => ({ command: 'codex', prefixArgs: [] }),
    resolveCodexThreadName: async () => ({ threadId: 'thread' }), runCodexDesktopTurn: run,
    codexRelayAttempts: new Map(), queueAgentLinkEvent: (_connection, event) => replies.push(event),
    addReceipt: () => {}, saveState: async () => { saved.push(JSON.parse(JSON.stringify(state.codexRelayPending))); },
    addActivity: () => {}, ROOT: process.cwd(), codexRelayReply: text => text, codexRelayFailureReason: error => error.message,
    codexRelayRetryTimer: {}, retryCodexRelayWhenDesktopReturns: () => retries++ };
  const drain = new Function(...Object.keys(dependencies), `return (${implementation});`)(...Object.values(dependencies));
  return { state, saved, replies, drain, attempts: dependencies.codexRelayAttempts, retries: () => retries };
}
async function flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }

test('two Link routes dispatch concurrently and return each reply only to its sender', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const muse = { id: 'link-muse', status: 'connected', capabilities: ['messages'], tokenHash: 'muse-hash', identity: { name: 'Muse' } };
  const ilander = { id: 'link-ilander', status: 'connected', capabilities: ['messages'], tokenHash: 'ilander-hash', identity: { name: 'iLander' } };
  const state = { settings: { codexRelay: { enabled: true, linkId: muse.id, threadId: 'thread-original-123', forwardReplies: true,
    routes: [{ enabled: true, linkId: ilander.id, threadId: 'thread-current-123', forwardReplies: true }] } }, codexRelayPending: [], agentLinks: [muse, ilander] };
  const starts = [], replies = [];
  let releaseMuse;
  const museReply = new Promise(resolve => { releaseMuse = resolve; });
  const dependencies = { state, codexRelayRunning: false, shuttingDown: false, codexRelayForLink, codexRelayConfigured, codexApprovedChats,
    connectorPolicy: () => null, codexRelayPrompt: ({ text }) => text, now: () => new Date().toISOString(),
    codexDesktopEnvironment: async () => ({}), harnessCommand: () => ({ command: 'codex', prefixArgs: [] }),
    runCodexDesktopTurn: async ({ threadId, prompt, onSubmitted }) => {
      starts.push({ threadId, prompt }); await onSubmitted({ threadId });
      return prompt === 'muse-question' ? museReply : { threadId, content: 'ilander-answer' };
    }, codexRelayAttempts: new Map(), queueAgentLinkEvent: (connection, event) => replies.push({ linkId: connection.id, ...event }),
    addReceipt: () => {}, saveState: async () => {}, addActivity: () => {}, ROOT: process.cwd(),
    codexRelayReply: text => text, codexRelayFailureReason: error => error.message, codexRelayRetryTimer: {}, retryCodexRelayWhenDesktopReturns: () => {} };
  const api = new Function(...Object.keys(dependencies), `${extractFunction(source, 'codexRelayJobAuthorized')}\n${extractFunction(source, 'relayAgentLinkMessage')}\n${extractFunction(source, 'startCodexRelayDrain')}\nreturn { queue:relayAgentLinkMessage, drain:startCodexRelayDrain, authorized:codexRelayJobAuthorized };`)(...Object.values(dependencies));
  assert.equal(api.queue(muse, { id: 'muse-message', text: 'muse-question' }), true);
  assert.equal(api.queue(ilander, { id: 'ilander-message', text: 'ilander-question' }), true);
  assert.equal(api.queue({ ...ilander, id: 'link-unconfigured' }, { id: 'unapproved-message', text: 'blocked' }), false);
  api.drain(); await flush();
  assert.deepEqual(starts, [{ threadId: 'thread-original-123', prompt: 'muse-question' }, { threadId: 'thread-current-123', prompt: 'ilander-question' }]);
  assert.deepEqual(replies.map(reply => [reply.linkId, reply.metadata.sourceMessageId]), [[ilander.id, 'ilander-message']]);
  releaseMuse({ threadId: 'thread-original-123', content: 'muse-answer' }); await flush();
  assert.deepEqual(replies.map(reply => [reply.linkId, reply.text]), [[ilander.id, 'ilander-answer'], [muse.id, 'muse-answer']]);
  const job = { linkId: ilander.id, tokenHash: ilander.tokenHash, threadId: 'thread-current-123' };
  const route = codexRelayForLink(state.settings.codexRelay, ilander.id);
  assert.equal(api.authorized(job, route, ilander), true);
  assert.equal(api.authorized(job, { ...route, enabled: false }, ilander), false);
  assert.equal(api.authorized(job, route, { ...ilander, capabilities: [] }), false);
  assert.equal(api.authorized(job, route, { ...ilander, tokenHash: 'rotated' }), false);
  assert.equal(api.authorized(job, codexRelayForLink(state.settings.codexRelay, muse.id), muse), false);
});

test('failed desktop startup retains durable intent and retry sends once', async () => {
  let calls = 0;
  const h = await harness(async ({ onSubmitted }) => {
    if (++calls === 1) throw new Error('The Codex desktop bridge is unavailable.');
    await onSubmitted({ threadId: 'thread', sameThread: false, previousTurn: 'old', previousTurnActive: false, cursor: 'cursor' });
    return { threadId: 'thread', content: 'reply' };
  });
  h.drain(); await flush();
  assert.equal(h.state.codexRelayPending.length, 1);
  assert.equal(h.saved.at(-1).length, 1);
  assert.equal(h.retries(), 1);
  h.drain(); await flush();
  assert.equal(h.state.codexRelayPending.length, 0);
  assert.equal(h.replies.length, 1);
});

test('ambiguous submission is retained and never automatically resent', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; throw Object.assign(new Error('lost acknowledgement'), { codexDeliveryStatus: 'uncertain' }); });
  h.drain(); await flush();
  assert.equal(h.saved.at(-1)[0].delivery, 'delivery-uncertain');
  h.drain(); await flush();
  assert.equal(calls, 1);
  assert.equal(h.state.codexRelayPending.length, 1);
});

test('recovered acknowledged delivery passes observation without another send', async () => {
  const observation = { threadId: 'thread', sameThread: false, previousTurn: 'old', previousTurnActive: false, cursor: 'cursor' };
  const h = await harness(async ({ resumeObservation, onSubmitted }) => {
    assert.deepEqual(resumeObservation, observation);
    await onSubmitted(resumeObservation);
    return { threadId: 'thread', content: 'recovered reply' };
  }, [{ id: 'first', linkId: 'link', threadId: 'thread', text: 'first', identity: {}, delivery: 'awaiting-reply', observation }]);
  h.drain(); await flush();
  assert.equal(h.replies[0].text, 'recovered reply');
  assert.equal(h.state.codexRelayPending.length, 0);
});

test('second send waits for first acknowledgement, but not its completed reply', async () => {
  let releaseAck;
  let releaseReply;
  const ack = new Promise(resolve => { releaseAck = resolve; });
  const reply = new Promise(resolve => { releaseReply = resolve; });
  const started = [];
  const h = await harness(async ({ prompt, onSubmitted }) => {
    started.push(prompt);
    if (prompt === 'first') await ack;
    await onSubmitted({ threadId: 'thread' });
    return prompt === 'first' ? reply : { threadId: 'thread', content: 'second reply' };
  }, ['first', 'second'].map(id => ({ id, linkId: 'link', threadId: 'thread', text: id, identity: {} })));
  h.drain(); await flush();
  assert.deepEqual(started, ['first']);
  assert.equal(h.saved.at(-1)[0].delivery, 'submitting');
  releaseAck(); await flush();
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(h.saved.at(-1)[0].delivery, 'awaiting-reply');
  releaseReply({ threadId: 'thread', content: 'first reply' }); await flush();
  assert.deepEqual(h.replies.map(event => event.metadata.sourceMessageId), ['second', 'first']);
});
