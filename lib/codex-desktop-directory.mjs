import { spawn } from 'node:child_process';
import { codexDesktopServerPath } from './codex-desktop-relay.mjs';

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,199}$/;
const TIMEOUT_MS = 15000;

function payload(result) {
  if (result?.isError) throw new Error('The Codex desktop bridge rejected the directory request.');
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const body = result?.content?.find((item) => item.type === 'text')?.text;
  if (typeof body !== 'string') throw new Error('The Codex desktop bridge returned no directory response.');
  try { return JSON.parse(body); }
  catch { throw new Error('The Codex desktop bridge returned an invalid directory response.'); }
}

function cleanChats(value) {
  const seen = new Set();
  const items = [...(Array.isArray(value.pinnedThreads) ? value.pinnedThreads : []), ...(Array.isArray(value.threads) ? value.threads : [])];
  return items.flatMap((item) => {
    if (!THREAD_ID.test(String(item?.id || '')) || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, title: String(item.title || ''), kind: String(item.kind || ''), projectId: item.projectId || null,
      hostId: item.hostId || null, status: String(item.status || ''), updatedAt: item.updatedAt || null }];
  });
}

function cleanProjects(value) {
  return (Array.isArray(value.projects) ? value.projects : []).flatMap((item) => PROJECT_ID.test(String(item?.projectId || ''))
    ? [{ projectId: item.projectId, label: String(item.label || ''), projectKind: String(item.projectKind || ''),
      hostId: item.hostId || null, isGitRepository: item.isGitRepository === true }]
    : []);
}

/** One bounded desktop app tool call. Caller applies Link authorization and policy first. */
export async function runCodexDesktopDirectory({ operation, callerThreadId, projectId, prompt, title, env = process.env,
  spawnFn = spawn, serverPath, timeoutMs = TIMEOUT_MS } = {}) {
  if (!THREAD_ID.test(String(callerThreadId || ''))) throw new Error('The Codex desktop caller thread is invalid.');
  const args = operation === 'chats' ? { name: 'list_threads', arguments: { limit: 50 } }
    : operation === 'projects' ? { name: 'list_projects', arguments: {} }
      : operation === 'create-chat' ? { name: 'create_thread', arguments: {
        prompt: String(prompt || ''), target: { type: 'project', projectId, environment: { type: 'local' } },
        ...(title ? { title: String(title) } : {})
      } } : null;
  if (!args) throw new Error('Unsupported Codex desktop directory operation.');
  if (operation === 'create-chat') {
    if (!PROJECT_ID.test(String(projectId || ''))) throw new Error('Choose an existing saved Codex project ID.');
    if (!String(prompt || '').trim() || String(prompt).length > 10000) throw new Error('The new Codex chat prompt must be 1 to 10000 characters.');
    if (title && (typeof title !== 'string' || title.length > 160)) throw new Error('The new Codex chat title is too long.');
  }
  const child = spawnFn(process.execPath, [serverPath || codexDesktopServerPath(env)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let nextId = 0; let closed = false;
  const pending = new Map();
  const fail = (error) => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    try { child.kill(); } catch { /* already exited */ }
  };
  child.stdout.setEncoding?.('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) return fail(new Error('The Codex desktop directory response was too large.'));
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { continue; }
      const task = pending.get(message.id); if (!task) continue;
      pending.delete(message.id);
      if (message.error) task.reject(new Error('The Codex desktop bridge rejected the directory request.'));
      else task.resolve(message.result);
    }
  });
  child.on('error', () => fail(new Error('The Codex desktop bridge could not start.')));
  child.on('close', () => fail(new Error('The Codex desktop bridge closed before the directory reply.')));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('The Codex desktop bridge is closed.'));
    const id = ++nextId; pending.set(id, { resolve, reject });
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
    catch { pending.delete(id); reject(new Error('The Codex desktop bridge could not accept a request.')); }
  });
  const watchdog = setTimeout(() => fail(new Error('The Codex desktop directory request timed out.')),
    Math.max(1000, Math.min(Number(timeoutMs) || TIMEOUT_MS, 60000)));
  try {
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hexigrid-link-codex-directory', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const result = payload(await request('tools/call', { ...args, _meta: { 'openai/threadId': callerThreadId } }));
    if (operation === 'chats') { const chats = cleanChats(result); return { chats, count: chats.length }; }
    if (operation === 'projects') { const projects = cleanProjects(result); return { projects, count: projects.length }; }
    if (!THREAD_ID.test(String(result.threadId || ''))) throw new Error('The Codex desktop bridge did not return a new chat ID.');
    return { threadId: result.threadId, hostId: result.hostId || null, title: String(title || ''), projectId };
  } finally {
    clearTimeout(watchdog); closed = true;
    for (const item of pending.values()) item.reject(new Error('The Codex desktop bridge closed.'));
    pending.clear();
    try { child.stdin.end(); child.kill(); } catch { /* best effort */ }
  }
}
