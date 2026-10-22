import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/;
const MAX_TURN_MS = 10 * 60 * 1000;

export function codexDesktopServerPath(env = process.env) {
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error('The Codex desktop bridge is unavailable.');
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || '', '.codex');
  if (!home || home === '.codex') throw new Error('The Codex desktop bridge is unavailable.');
  const root = path.join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  let versions;
  try { versions = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
  catch { throw new Error('The Codex desktop bridge is unavailable.'); }
  if (!versions.length) throw new Error('The Codex desktop bridge is unavailable.');
  return path.join(root, versions[0], 'server.mjs');
}

function toolPayload(reply) {
  if (reply?.isError) throw new Error('The Codex desktop bridge rejected a request.');
  const body = reply?.content?.find((item) => item.type === 'text')?.text;
  if (typeof body !== 'string') throw new Error('The Codex desktop bridge returned no response.');
  try { return JSON.parse(body); }
  catch { throw new Error('The Codex desktop bridge returned an invalid response.'); }
}

/** Deliver one Link message through the desktop application's own task bridge. */
export async function runCodexDesktopTurn({ threadId, callerThreadId, prompt, signal, env = process.env, spawnFn = spawn, serverPath, timeoutMs = MAX_TURN_MS,
  onSubmitted, resumeObservation, assertAuthorized } = {}) {
  if (!THREAD_ID.test(String(threadId || '')) || !THREAD_ID.test(String(callerThreadId || ''))) throw new Error('The Codex desktop thread target is invalid.');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 51000) throw new Error('The Codex relay prompt is invalid.');
  const child = spawnFn(process.execPath, [serverPath || codexDesktopServerPath(env)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const failAll = (error) => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    try { child.kill(); } catch { /* process already exited */ }
  };
  const abort = () => failAll(new Error('The Codex desktop relay was interrupted.'));
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding?.('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) return failAll(new Error('The Codex desktop bridge response was too large.'));
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const task = pending.get(message.id);
      if (!task) continue;
      pending.delete(message.id);
      if (message.error) task.reject(new Error('The Codex desktop bridge rejected a request.'));
      else task.resolve(message.result);
    }
  });
  child.on('error', () => failAll(new Error('The Codex desktop bridge could not start.')));
  child.on('close', () => failAll(new Error('The Codex desktop bridge closed before the reply.')));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('The Codex desktop bridge is closed.'));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
    catch { pending.delete(id); reject(new Error('The Codex desktop bridge could not accept a request.')); }
  });
  const call = async (name, args) => toolPayload(await request('tools/call', { name, arguments: args, _meta: { 'openai/threadId': callerThreadId } }));
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || MAX_TURN_MS, MAX_TURN_MS));
  const watchdog = setTimeout(() => failAll(new Error('The Codex desktop turn timed out.')), deadline - Date.now());
  let submissionAttempted = false;
  let observation = resumeObservation || null;
  try {
    if (signal?.aborted) throw new Error('The Codex desktop relay was interrupted.');
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hexigrid-link-desktop-relay', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const sameThread = threadId === callerThreadId;
    // wait_threads deliberately refuses its calling thread. read_thread is
    // read-only and can observe the queued turn after this desktop task yields.
    if (resumeObservation && (resumeObservation.threadId !== threadId || resumeObservation.sameThread !== sameThread ||
      typeof resumeObservation.previousTurn !== 'string' || typeof resumeObservation.previousTurnActive !== 'boolean')) {
      throw new Error('The Codex desktop observation identity is invalid.');
    }
    const before = resumeObservation ? null : sameThread
      ? await call('read_thread', { threadId, turnLimit: 2, maxOutputCharsPerItem: 20000 })
      : await call('wait_threads', { targets: [{ threadId }], timeoutMs: 0 });
    const previousTurn = resumeObservation ? resumeObservation.previousTurn : sameThread
      ? before.turns?.[0]?.id || ''
      : before.polls?.find((poll) => poll.thread?.id === threadId)?.latestTurn?.id || '';
    const previousTurnActive = resumeObservation ? resumeObservation.previousTurnActive : sameThread && Boolean(previousTurn) && !['completed', 'failed', 'interrupted'].includes(before.turns?.[0]?.status);
    let cursor = resumeObservation ? resumeObservation.cursor : sameThread ? '' : before.polls?.find((poll) => poll.thread?.id === threadId)?.cursor;
    let joinedTurnId = previousTurnActive ? previousTurn : '';
    if (!resumeObservation) {
      assertAuthorized?.();
      submissionAttempted = true;
      await call('send_message_to_thread', { threadId, prompt });
      observation = { threadId, sameThread, previousTurn, previousTurnActive, cursor: cursor || '' };
      await onSubmitted?.(observation);
    } else await onSubmitted?.(observation);
    while (Date.now() < deadline) {
      if (sameThread) {
        const snapshot = await call('read_thread', { threadId, turnLimit: 2, maxOutputCharsPerItem: 20000 });
        // A goal continuation can become the latest turn before this observer
        // runs. Keep the joined active turn's identity instead of losing its
        // completed reply behind that unrelated continuation.
        const turns = snapshot.turns || [];
        if (!joinedTurnId) {
          const previousIndex = turns.findIndex((item) => item.id === previousTurn);
          const newer = previousIndex < 0 ? turns : turns.slice(0, previousIndex);
          joinedTurnId = newer.at(-1)?.id || '';
        }
        const turn = turns.find((item) => item.id === joinedTurnId);
        // A message sent to the calling chat can join its in-progress turn.
        // Observe completion of that turn as well as a newly queued turn.
        if (turn?.id && (turn.id !== previousTurn || previousTurnActive)) {
          if (turn.status === 'failed' || turn.status === 'interrupted') throw new Error('The Codex desktop turn ended without a completed response.');
          if (turn.status === 'completed') {
            const answer = turn.items?.findLast((item) => item.type === 'agentMessage' && item.phase === 'final_answer');
            if (!answer) throw new Error('The Codex desktop turn completed without a final reply.');
            return { threadId, content: String(answer.text || '').trim(), turnId: turn.id };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
        continue;
      }
      const waitMs = Math.max(0, Math.min(60000, deadline - Date.now()));
      const result = await call('wait_threads', { targets: [{ threadId, ...(cursor ? { afterCursor: cursor } : {}) }], timeoutMs: waitMs });
      const poll = result.polls?.find((item) => item.thread?.id === threadId);
      if (poll?.cursor) cursor = poll.cursor;
      const turn = poll?.latestTurn;
      if (!turn?.id || turn.id === previousTurn) continue;
      if (turn.status !== 'completed') {
        if (turn.status === 'failed' || turn.status === 'interrupted') throw new Error('The Codex desktop turn ended without a completed response.');
        continue;
      }
      const answer = poll.latestAssistantMessage;
      if (answer?.turnId !== turn.id || answer.phase !== 'final_answer') throw new Error('The Codex desktop turn completed without a final reply.');
      return { threadId, content: String(answer.text || '').trim(), turnId: turn.id };
    }
    throw new Error('The Codex desktop turn timed out.');
  } catch (error) {
    error.codexDeliveryStatus = observation ? 'submitted' : submissionAttempted ? 'uncertain' : 'not-submitted';
    if (observation) error.codexObservation = observation;
    throw error;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', abort);
    closed = true;
    for (const { reject } of pending.values()) reject(new Error('The Codex desktop bridge closed.'));
    pending.clear();
    try { child.stdin.end(); child.kill(); } catch { /* best effort */ }
  }
}
