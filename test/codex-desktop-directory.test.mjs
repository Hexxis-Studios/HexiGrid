import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runCodexDesktopDirectory } from '../lib/codex-desktop-directory.mjs';

function bridge(reply) {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdin = { write(raw) {
    const message = JSON.parse(raw.trim()); sent.push(message);
    if (message.id) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id,
      result: message.method === 'initialize' ? {} : { content: [{ type: 'text', text: JSON.stringify(reply) }] } })}\n`));
  }, end() {} };
  child.kill = () => {};
  return { child, sent };
}

test('desktop directory lists chats without summaries and deduplicates pinned items', async () => {
  const { child, sent } = bridge({ pinnedThreads: [{ id: 'thread-12345678', title: 'One', kind: 'codex', projectId: 'project-123', summary: 'private' }],
    threads: [{ id: 'thread-12345678', title: 'One' }, { id: 'thread-abcdefgh', title: 'Two', kind: 'chatgpt' }] });
  const result = await runCodexDesktopDirectory({ operation: 'chats', callerThreadId: 'thread-caller-123', serverPath: 'fake.mjs', spawnFn: () => child });
  assert.equal(result.count, 2);
  assert.deepEqual(result.chats.map((chat) => chat.title), ['One', 'Two']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(sent.find((item) => item.params?.name === 'list_threads').params._meta['openai/threadId'], 'thread-caller-123');
});

test('desktop directory lists saved projects and creates one chat in a selected local project', async () => {
  const list = bridge({ projects: [{ projectId: 'project-123', label: 'HexiGrid', projectKind: 'local', isGitRepository: true, path: 'C:\\private' }] });
  const projects = await runCodexDesktopDirectory({ operation: 'projects', callerThreadId: 'thread-caller-123', serverPath: 'fake.mjs', spawnFn: () => list.child });
  assert.deepEqual(projects, { count: 1, projects: [{ projectId: 'project-123', label: 'HexiGrid', projectKind: 'local', hostId: null, isGitRepository: true }] });
  const create = bridge({ threadId: 'thread-newchat-123', hostId: 'local' });
  const result = await runCodexDesktopDirectory({ operation: 'create-chat', callerThreadId: 'thread-caller-123', projectId: 'project-123', prompt: 'Harmless first request', title: 'Test chat', serverPath: 'fake.mjs', spawnFn: () => create.child });
  assert.equal(result.threadId, 'thread-newchat-123');
  assert.deepEqual(create.sent.find((item) => item.params?.name === 'create_thread').params.arguments,
    { prompt: 'Harmless first request', target: { type: 'project', projectId: 'project-123', environment: { type: 'local' } }, title: 'Test chat' });
});

test('desktop directory rejects invalid create inputs before opening bridge', async () => {
  await assert.rejects(runCodexDesktopDirectory({ operation: 'create-chat', callerThreadId: 'thread-caller-123', projectId: 'bad project', prompt: 'Hello', spawnFn: () => { throw new Error('must not spawn'); } }), /project ID/);
  await assert.rejects(runCodexDesktopDirectory({ operation: 'create-chat', callerThreadId: 'thread-caller-123', projectId: 'project-123', prompt: '', spawnFn: () => { throw new Error('must not spawn'); } }), /prompt/);
});
