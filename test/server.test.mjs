import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from 'node:http';
import { once } from 'node:events';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let port;
let processUnderTest;
let tempData;
let ownerSessionCookie;

async function removeTestAgent(agentId) {
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'content-type': 'application/json', ...(ownerSessionCookie ? { cookie: ownerSessionCookie } : {}) };
  const { settings } = await (await fetch(`${base}/api/bootstrap`, { headers })).json();
  const setMode = workMode => fetch(`${base}/api/settings`, { method: 'PATCH', headers, body: JSON.stringify({ workMode }) });
  await setMode('build');
  try {
    const response = await fetch(`${base}/api/agents/${agentId}`, { method: 'DELETE', headers, body: JSON.stringify({ approved: true }) });
    assert.equal(response.status, 200, 'disposable agent cleanup uses the confirmed owner removal contract');
    return response;
  } finally { await setMode(settings.workMode); }
}

test("a new control room starts without fake agent profiles", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  const body = await response.json();
  assert.deepEqual(body.agents, []);
  assert.deepEqual(body.usage, []);
  assert.deepEqual(body.rooms, []);
  assert.deepEqual(body.activity, []);
  assert.deepEqual(body.receipts, []);
  assert.deepEqual(body.tasks, []);
});

test('room stop cancels provider work, rejects stale stop IDs and retains the user message', async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  let closed;
  const cancelled = new Promise((resolve) => { closed = resolve; });
  const providerServer = http.createServer((req, res) => {
    req.resume();
    res.on('close', closed);
    started();
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  try {
    const { provider } = await request('/api/providers', 'POST', { name: 'Stop QA local', baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`, models: 'stop-qa' });
    const { agent } = await request('/api/agents', 'POST', { name: 'Stop QA', transport: 'local-opencode', model: `provider:${provider.id}:stop-qa` });
    const { room } = await request('/api/rooms', 'POST', { name: 'Stop QA room' });
    const endpoint = `/api/rooms/${room.id}`;
    const reply = request(`${endpoint}/messages`, 'POST', { content: 'Harmless QA', agentIds: [agent.id], requestId: 'current-turn' });
    await waiting;
    assert.equal((await request(`${endpoint}/stop`, 'POST', { requestId: 'old-turn' })).status, 409);
    assert.equal((await request(`${endpoint}/messages`, 'POST', { content: 'Duplicate', agentIds: [agent.id] })).status, 409);
    const stop = await request(`${endpoint}/stop`, 'POST', { requestId: 'current-turn' });
    assert.equal(stop.stopped, true, JSON.stringify(stop));
    const result = await reply;
    await cancelled;
    assert.equal(result.stopped, true);
    assert.equal(result.room.messages.length, 1);
    assert.equal(result.room.messages[0].content, 'Harmless QA');
    assert.deepEqual(result.replies, []);
    assert.equal((await request(`${endpoint}/stop`, 'POST', { requestId: 'current-turn' })).stopped, false);
  } finally { providerServer.closeAllConnections(); await new Promise((resolve) => providerServer.close(resolve)); }
});

test('durable room provider failure leaves one safe receipt and explicit retry recovers', { timeout: 15_000 }, async () => {
  let offline = true, calls = 0;
  const backend = http.createServer((req, res) => {
    req.resume(); calls++;
    res.writeHead(offline ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(offline ? { error: { message: 'Synthetic connection unavailable.' } }
      : { choices: [{ message: { content: 'RECOVERED' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const { body: { provider } } = await request('/api/providers', 'POST', {
      name: 'Recovery fixture', baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, models: 'recovery-fixture' });
    const { body: { agent } } = await request('/api/agents', 'POST', { name: 'Recovery fixture', transport: 'local-opencode',
      model: `provider:${provider.id}:recovery-fixture`, useGlobalCommunication: false, useMemories: false, learnFromConversations: false });
    const { body: { room } } = await request('/api/rooms', 'POST', { name: 'Recovery fixture' });
    async function turn(requestId) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const queued = await request(`/api/rooms/${room.id}/turns`, 'POST', { requestId, content: 'Harmless recovery check', agentIds: [agent.id] });
        if (queued.status === 202) break;
        assert.equal(queued.status, 409); assert.ok(attempt < 99, 'the previous turn must settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = (await request('/api/rooms')).body.rooms.find(item => item.id === room.id);
        if (snapshot.replyChain.requestId === requestId && ['blocked', 'completed'].includes(snapshot.replyChain.status)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('the bounded fixture turn must settle');
    }
    const failed = await turn('unavailable-route');
    assert.equal(failed.replyChain.status, 'blocked');
    assert.match(failed.replyChain.error, /unavailable/i);
    assert.equal(failed.messages.some(item => item.role === 'agent'), false);
    const failedReceipts = async () => (await request('/api/bootstrap')).body.receipts
      .filter(item => item.agentId === agent.id && item.action === 'room:reply' && item.status === 'failed');
    const receipts = await failedReceipts();
    assert.equal(receipts.length, 1, 'the primary chat workflow must retain a failed-action receipt');
    assert.doesNotMatch(receipts[0].detail, /Harmless recovery check|Synthetic connection unavailable/,
      'receipts must not copy the prompt or untrusted provider response');
    const failedAttempts = calls;
    assert.ok(failedAttempts >= 1 && failedAttempts <= 3, 'transient upstream failure retries remain bounded');
    await request('/api/rooms');
    assert.equal(calls, failedAttempts, 'reading a blocked turn never replays it');
    offline = false;
    const recovered = await turn('explicit-retry');
    assert.equal(recovered.replyChain.status, 'completed');
    assert.equal(recovered.messages.at(-1).content, 'RECOVERED');
    assert.equal(recovered.messages.filter(item => item.role === 'user').length, 2);
    assert.equal((await failedReceipts()).length, 1, 'recovery does not duplicate the failed receipt');
    assert.equal(calls, failedAttempts + 1);
  } finally { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});

test('room archive retains history, blocks all message paths and restores the same room', async () => {
  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const created = await request('/api/rooms', 'POST', { name: 'Recoverable QA room' });
  assert.equal(created.status, 201);
  const room = created.body.room;
  const endpoint = `/api/rooms/${room.id}`;
  const archived = await request(endpoint, 'PATCH', { archived: true });
  assert.equal(archived.body.room.archived, true);
  assert.deepEqual(archived.body.room.messages, room.messages);
  for (const suffix of ['user', 'browser', '']) {
    const result = await request(`${endpoint}/messages${suffix ? '/' + suffix : ''}`, 'POST', { content: 'Must not be stored' });
    assert.equal(result.status, 409);
  }
  const invalid = await request(endpoint, 'PATCH', { archived: 'false', name: 'Must not rename' });
  assert.equal(invalid.status, 400);
  const restored = await request(endpoint, 'PATCH', { archived: false });
  assert.equal(restored.body.room.id, room.id);
  assert.equal(restored.body.room.name, room.name);
  assert.equal(restored.body.room.archived, false);
  assert.deepEqual(restored.body.room.messages, room.messages);
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start.");
}

async function startTestServer() {
  processUnderTest = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: tempData, HEXIGRID_PAIR_CODE: 'ABCDEF12', OPENCODE_CLI: "missing-opencode-for-test" },
    stdio: "ignore"
  });
  await waitForServer();
}

before(async () => {
  tempData = await mkdtemp(path.join(os.tmpdir(), "hexigrid-test-"));
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await startTestServer();
});

after(async () => {
  if (processUnderTest && processUnderTest.exitCode === null && processUnderTest.signalCode === null) {
    const exited = once(processUnderTest, 'exit');
    processUnderTest.kill();
    await exited;
  }
  const resolved = path.resolve(tempData);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Test cleanup must stay inside the OS temp directory.");
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test("local responses include browser security headers", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /style-src 'self'/); assert.match(csp, /style-src-attr 'none'/); assert.doesNotMatch(csp, /(?:^|[;\s])'(?:unsafe-inline|unsafe-eval)'(?:[;\s]|$)/);
  const { AVATAR_VIEWER_STYLE_HASHES } = await import('../lib/avatar-viewer-style-hashes.mjs');
  for (const hash of AVATAR_VIEWER_STYLE_HASHES) assert.ok(csp.includes(hash), 'fixed avatar stylesheet must be allowed');
  assert.equal(response.headers.get('strict-transport-security'), null, 'loopback HTTP must not advertise HSTS');
});

test('the focused Live page can be framed only by an explicitly trusted HexiSpace origin', async () => {
  const local = await fetch(`http://127.0.0.1:${port}/?embedded=1&view=live&parent=http%3A%2F%2F127.0.0.1%3A4340`);
  assert.equal(local.status, 200);
  assert.match(local.headers.get('content-security-policy'), /frame-ancestors http:\/\/127\.0\.0\.1:4340/);
  assert.equal(local.headers.get('x-frame-options'), null);
  assert.match(await local.text(), /hexispace-embed-mode\.js/);

  const untrusted = await fetch(`http://127.0.0.1:${port}/?embedded=1&view=live&parent=https%3A%2F%2Fevil\.example`);
  assert.equal(untrusted.status, 200);
  assert.match(untrusted.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(untrusted.headers.get('x-frame-options'), 'DENY');
});

test('PWA raster assets are served with the correct type and cannot open arbitrary files', async () => {
  const icon = await fetch(`http://127.0.0.1:${port}/icon-maskable-512.png`);
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array((await icon.arrayBuffer()).slice(0, 8))], [137,80,78,71,13,10,26,10]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/splash-../../server.png`)).status, 404);
  const browserRuntime = await fetch(`http://127.0.0.1:${port}/vendor/web-llm.js`);
  assert.equal(browserRuntime.status, 200);
  assert.match(browserRuntime.headers.get('content-type'), /javascript/);
  assert.ok((await browserRuntime.arrayBuffer()).byteLength > 1000000);
});

test('launcher identity endpoint and runtime record agree without exposing private state', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/system/identity`); const identity = await response.json();
  assert.deepEqual(Object.keys(identity).sort(), ['developmentFreshStart', 'instanceId', 'pid', 'port', 'product', 'scheme', 'sourceDigest', 'version'].sort());
  assert.match(identity.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(identity.developmentFreshStart, false);
  assert.equal(identity.product, 'hexigrid'); assert.equal(identity.pid, processUnderTest.pid); assert.equal(identity.port, port);
  const runtime = JSON.parse(await readFile(path.join(tempData, '.runtime.json'), 'utf8'));
  assert.equal(runtime.instanceId, identity.instanceId); assert.equal(runtime.pid, identity.pid); assert.equal(runtime.port, identity.port); assert.equal(runtime.product, 'hexigrid');
});

test('HexiSpace connector manifest is served from the local control plane', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/manifest`);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.protocol, 'hexispace-control');
  assert.equal(manifest.hexigridVersion, '0.0.1');
  assert.equal(manifest.origin, `http://127.0.0.1:${port}`);
  assert.deepEqual(manifest.capabilities, ['messages', 'scheduled_work', 'mailboxes', 'emergency_stop', 'artifacts', 'agent_profiles', 'agent_posts', 'agent_comments', 'agent_friends', 'agent_relationships', 'agent_reactions']);
});

test("mutations from a foreign browser origin are rejected", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ workMode: "build" })
  });
  assert.equal(response.status, 403);
});

test("workspace paths cannot escape the private root", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace/file?path=../../server.mjs`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the HexiGrid workspace/);
});

test("Converse mode denies workspace writes", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/blocked.txt", content: "no" })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).denied, true);
});

test("oversized request bodies are rejected", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(response.status, 413);
});

test('provider registration discovers current models when the user supplies only a key', async () => {
  const modelServer = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer discovery-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'current-a' }, { id: 'current-b' }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Discovered local', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, models: '', apiStyle: 'openai-chat', apiKey: 'discovery-key' }) });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(body.provider.modelIds, ['current-a', 'current-b']);
    assert.doesNotMatch(JSON.stringify(body), /discovery-key/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/providers/${body.provider.id}`, { method: 'DELETE' })).status, 200);
  } finally { await new Promise(resolve => modelServer.close(resolve)); }
});

test('provider registration routes a room reply and records exact metering',async()=>{
  const providerServer=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    assert.equal(req.url,'/v1/chat/completions');
    assert.equal(JSON.parse(body).model,'test-model');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:'Integration reply'}}],usage:{prompt_tokens:32,completion_tokens:4}}));
  });
  await new Promise(resolve=>providerServer.listen(0,'127.0.0.1',resolve));
  const request=async(url,method,body)=>{const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  try{
    const {provider,status}=await request('/api/providers','POST',{name:'Integration local',baseUrl:`http://127.0.0.1:${providerServer.address().port}/v1`,models:'test-model'});
    assert.equal(status,201);
    const model=`provider:${provider.id}:test-model`;
    const {agent}=await request('/api/agents','POST',{name:'Integration agent',transport:'local-opencode',model});
    assert.equal(agent.model,model);
    const {room}=await request('/api/rooms','POST',{name:'Integration room'});
    const result=await request(`/api/rooms/${room.id}/messages`,'POST',{content:'Test',agentIds:[agent.id]});
    assert.equal(result.replies[0].content,'Integration reply');
    const bootstrap=await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
    const usage=bootstrap.usage.find(item=>item.agentId===agent.id);
    assert.equal(usage.inputTokens,32);assert.equal(usage.outputTokens,4);assert.equal(usage.estimated,false);
    assert.equal((await request(`/api/providers/${provider.id}`,'DELETE')).status,409);
    await removeTestAgent(agent.id);
    assert.equal((await request(`/api/providers/${provider.id}`,'DELETE')).status,200);
  }finally{await new Promise(resolve=>providerServer.close(resolve));}
});

test('owner one-shot task completes through a local provider and persists its result and receipt', async () => {
  const providerRequests = [];
  const providerServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    providerRequests.push({ url: req.url, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Completed one bounded local step.' } }], usage: { prompt_tokens: 17, completion_tokens: 5 } }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const before = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
  let providerId, agentId;
  try {
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'review' });
    const providerResult = await request('/api/providers', 'POST', { name: 'One-shot task QA', baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`, models: 'task-qa' });
    assert.equal(providerResult.status, 201);
    providerId = providerResult.provider.id;
    const agentResult = await request('/api/agents', 'POST', { name: 'One-shot task QA', transport: 'local-opencode', model: `provider:${providerId}:task-qa` });
    assert.equal(agentResult.status, 201);
    agentId = agentResult.agent.id;
    const created = await request('/api/tasks', 'POST', { name: 'One bounded QA task', agentId, prompt: 'Return the result of one harmless local step.', intervalSeconds: 0, maxRuns: 1, maxRetries: 0 });
    assert.equal(created.status, 201);
    assert.equal(created.task.status, 'paused');
    assert.equal(created.task.maxRuns, 1);

    const run = await request(`/api/tasks/${created.task.id}/run`, 'POST', {});
    assert.equal(run.status, 200);
    assert.equal(run.run.status, 'completed');
    assert.equal(run.run.output, 'Completed one bounded local step.');
    const after = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
    const savedTask = after.tasks.find((item) => item.id === created.task.id);
    const savedRun = after.taskRuns.find((item) => item.id === run.run.id);
    assert.equal(savedTask.status, 'completed');
    assert.equal(savedTask.runCount, 1);
    assert.equal(savedTask.nextRunAt, null);
    assert.equal(savedRun.output, 'Completed one bounded local step.');
    assert.ok(after.receipts.some((receipt) => receipt.source === 'task' && receipt.action === savedTask.name && receipt.status === 'completed'));
    assert.equal(providerRequests.length, 1);
    assert.equal(providerRequests[0].url, '/v1/chat/completions');
    assert.equal(providerRequests[0].body.model, 'task-qa');
    const usage = after.usage.find((item) => item.agentId === agentId && item.source === 'task');
    assert.equal(usage.inputTokens, 17);
    assert.equal(usage.outputTokens, 5);
    assert.equal(usage.estimated, false);
  } finally {
    if (agentId) await removeTestAgent(agentId);
    if (providerId) await request(`/api/providers/${providerId}`, 'DELETE');
    await request('/api/settings', 'PATCH', { workMode: before.settings.workMode, approvalPolicy: before.settings.approvalPolicy });
    providerServer.closeAllConnections();
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('owner cancellation stops the exact active local task without saving a completed output', async () => {
  let started, providerClosed, deadline;
  const entered = new Promise(resolve => { started = resolve; });
  const closed = new Promise(resolve => { providerClosed = resolve; });
  let providerCalls = 0;
  const providerServer = http.createServer((req, res) => {
    providerCalls++;
    req.resume();
    res.on('close', providerClosed);
    started();
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, ...await response.json() };
  };
  const before = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
  let providerId, agentId, pending;
  try {
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'review' });
    const createdProvider = await request('/api/providers', 'POST', { name: 'Task Stop QA', baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`, models: 'task-stop-qa' });
    assert.equal(createdProvider.status, 201);
    providerId = createdProvider.provider.id;
    const createdAgent = await request('/api/agents', 'POST', { name: 'Task Stop QA', transport: 'local-opencode', model: `provider:${providerId}:task-stop-qa` });
    assert.equal(createdAgent.status, 201);
    agentId = createdAgent.agent.id;
    const created = await request('/api/tasks', 'POST', { name: 'Cancellable local QA', agentId, prompt: 'Wait for harmless QA cancellation.', intervalSeconds: 60, maxRuns: 2, maxRetries: 2 });
    assert.equal(created.status, 201);
    pending = request(`/api/tasks/${created.task.id}/run`, 'POST', {});
    pending.catch(() => {});
    await Promise.race([entered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Local task did not reach its provider.')), 3000); })]);
    clearTimeout(deadline);
    const active = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
    assert.ok(active.taskRuns.some(run => run.taskId === created.task.id && run.status === 'running'));
    assert.equal((await request(`/api/tasks/${created.task.id}/run`, 'POST', {})).status, 409);
    const stop = await request(`/api/tasks/${created.task.id}/cancel`, 'POST', {});
    assert.equal(stop.status, 200);
    assert.equal(stop.task.status, 'cancelled');
    const result = await pending;
    assert.equal(result.status, 502);
    assert.equal(result.run.status, 'cancelled');
    assert.equal(result.run.output, '');
    await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Local provider transport did not close after Stop.')), 1500); })]);
    clearTimeout(deadline);
    const after = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
    const task = after.tasks.find(item => item.id === created.task.id);
    assert.equal(task.status, 'cancelled');
    assert.equal(task.runCount, 0);
    assert.equal(task.nextRunAt, null);
    assert.equal(after.taskRuns.filter(run => run.taskId === task.id).length, 1);
    assert.ok(after.receipts.some(receipt => receipt.source === 'task' && receipt.action === `task:${task.id}:cancel` && receipt.status === 'cancelled'));
    assert.equal(after.usage.filter(item => item.agentId === agentId).length, 0);
    assert.equal(providerCalls, 1);
  } finally {
    clearTimeout(deadline);
    providerServer.closeAllConnections();
    await new Promise(resolve => providerServer.close(resolve));
    if (pending) await pending.catch(() => {});
    if (agentId) await removeTestAgent(agentId);
    if (providerId) await request(`/api/providers/${providerId}`, 'DELETE');
    await request('/api/settings', 'PATCH', { workMode: before.settings.workMode, approvalPolicy: before.settings.approvalPolicy });
  }
});

test('owner schedules repeat to their bound and Pause during a local run prevents another step', async () => {
  const calls = [];
  let pauseEntered, releasePaused;
  const pauseStarted = new Promise(resolve => { pauseEntered = resolve; });
  const pausedResponse = new Promise(resolve => { releasePaused = resolve; });
  const providerServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    if (body.messages.some(message => message.content.includes('QA-PAUSE-SCHEDULE'))) {
      pauseEntered();
      await pausedResponse;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: `Local scheduled result ${calls.length}.` } }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    return { status: response.status, ...await response.json() };
  };
  const waitForTask = async (taskId, predicate) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const snapshot = await request('/api/tasks', 'GET');
      const task = snapshot.tasks.find(item => item.id === taskId);
      if (task && predicate(task)) return { task, runs: snapshot.runs.filter(run => run.taskId === taskId) };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Scheduled task did not reach its expected state.');
  };
  const before = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
  let providerId, agentId, pauseId, deadline;
  try {
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'review' });
    const provider = await request('/api/providers', 'POST', { name: 'Recurrence QA', baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`, models: 'schedule-qa' });
    assert.equal(provider.status, 201); providerId = provider.provider.id;
    const agent = await request('/api/agents', 'POST', { name: 'Recurrence QA', transport: 'local-opencode', model: `provider:${providerId}:schedule-qa` });
    assert.equal(agent.status, 201); agentId = agent.agent.id;
    const created = await request('/api/tasks', 'POST', { name: 'Bounded recurrence QA', agentId, prompt: 'QA-BOUNDED-SCHEDULE: return one harmless step.', intervalSeconds: 1, maxRuns: 2, maxRetries: 0 });
    assert.equal(created.status, 201);
    assert.equal((await request(`/api/tasks/${created.task.id}`, 'PATCH', { status: 'running' })).status, 200);
    const completed = await waitForTask(created.task.id, task => task.status === 'completed');
    assert.equal(completed.task.runCount, 2);
    assert.equal(completed.task.nextRunAt, null);
    assert.equal(completed.runs.length, 2);
    assert.ok(completed.runs.every(run => run.status === 'completed'));
    assert.equal(calls.length, 2);
    assert.ok(calls[1].messages.some(message => message.content.includes('Previous run output:\nLocal scheduled result 1.')), 'the second step receives the retained first result');
    assert.equal((await request(`/api/tasks/${created.task.id}/run`, 'POST', {})).status, 409);

    const pauseTask = await request('/api/tasks', 'POST', { name: 'Pause recurrence QA', agentId, prompt: 'QA-PAUSE-SCHEDULE: return one harmless step.', intervalSeconds: 1, maxRuns: 3, maxRetries: 2 });
    assert.equal(pauseTask.status, 201); pauseId = pauseTask.task.id;
    assert.equal((await request(`/api/tasks/${pauseId}`, 'PATCH', { status: 'running' })).status, 200);
    await Promise.race([pauseStarted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Pause QA provider did not start.')), 3000); })]);
    clearTimeout(deadline);
    assert.equal((await request(`/api/tasks/${pauseId}`, 'PATCH', { status: 'paused' })).status, 200);
    releasePaused();
    const paused = await waitForTask(pauseId, task => task.status === 'paused' && task.runCount === 1);
    assert.equal(paused.task.nextRunAt, null);
    assert.equal(paused.runs.length, 1);
    assert.equal(paused.runs[0].status, 'completed');
    assert.equal(paused.task.lastOutput, 'Local scheduled result 3.');
    assert.equal(calls.length, 3);
  } finally {
    clearTimeout(deadline);
    releasePaused();
    if (pauseId) await request(`/api/tasks/${pauseId}/cancel`, 'POST', {});
    providerServer.closeAllConnections();
    await new Promise(resolve => providerServer.close(resolve));
    if (agentId) await removeTestAgent(agentId);
    if (providerId) await request(`/api/providers/${providerId}`, 'DELETE');
    await request('/api/settings', 'PATCH', { workMode: before.settings.workMode, approvalPolicy: before.settings.approvalPolicy });
  }
});

test('interrupted manual tasks reopen paused with prior results and never replay automatically', async () => {
  let providerCalls = 0, entered, deadline;
  const pendingProvider = new Promise(resolve => { entered = resolve; });
  const providerServer = http.createServer((req, res) => {
    providerCalls++;
    req.resume();
    if (providerCalls === 1) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Earlier completed result.' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    } else entered();
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, ...await response.json() };
  };
  const before = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
  let providerId, agentId, interruptedRequest;
  const restartOwnServer = async () => {
    assert.ok(processUnderTest?.pid && processUnderTest.spawnfile === process.execPath, 'restart only the exact Node child spawned by this fixture');
    const exited = once(processUnderTest, 'exit');
    processUnderTest.kill();
    await exited;
    await startTestServer();
  };
  try {
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'review' });
    const provider = await request('/api/providers', 'POST', { name: 'Manual restart QA', baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`, models: 'restart-qa' });
    assert.equal(provider.status, 201); providerId = provider.provider.id;
    const agent = await request('/api/agents', 'POST', { name: 'Manual restart QA', transport: 'local-opencode', model: `provider:${providerId}:restart-qa` });
    assert.equal(agent.status, 201); agentId = agent.agent.id;
    const created = await request('/api/tasks', 'POST', { name: 'Manual restart QA', agentId, prompt: 'Return a harmless manual step.', intervalSeconds: 60, maxRuns: 3, maxRetries: 2 });
    assert.equal(created.status, 201);
    assert.equal((await request(`/api/tasks/${created.task.id}/run`, 'POST', {})).run.status, 'completed');
    interruptedRequest = request(`/api/tasks/${created.task.id}/run`, 'POST', {}).catch(error => error);
    await Promise.race([pendingProvider, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Manual restart QA provider did not start.')), 3000); })]);
    clearTimeout(deadline);
    await restartOwnServer();
    assert.ok((await interruptedRequest) instanceof Error, 'the interrupted HTTP invocation did not claim completion');
    const reopened = await request('/api/tasks', 'GET');
    const savedTask = reopened.tasks.find(task => task.id === created.task.id);
    const runs = reopened.runs.filter(run => run.taskId === created.task.id);
    assert.equal(savedTask.status, 'paused');
    assert.equal(savedTask.nextRunAt, null);
    assert.equal(savedTask.runCount, 1);
    assert.equal(savedTask.lastOutput, 'Earlier completed result.');
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'interrupted');
    assert.match(runs[0].error, /stopped before this run finished/);
    assert.equal(runs[1].status, 'completed');
    assert.equal(runs[1].output, 'Earlier completed result.');
    const interruptedAt = runs[0].finishedAt;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(providerCalls, 2, 'an enabled worker tick cannot turn a manual run into a schedule');
    await restartOwnServer();
    const second = await request('/api/tasks', 'GET');
    assert.equal(second.tasks.find(task => task.id === savedTask.id).status, 'paused');
    assert.equal(second.runs.find(run => run.id === runs[0].id).finishedAt, interruptedAt, 'startup recovery was durably saved, not recreated on each launch');
    assert.equal(providerCalls, 2);
  } finally {
    clearTimeout(deadline);
    providerServer.closeAllConnections();
    await new Promise(resolve => providerServer.close(resolve));
    if (interruptedRequest) await interruptedRequest;
    if (agentId) await removeTestAgent(agentId);
    if (providerId) await request(`/api/providers/${providerId}`, 'DELETE');
    await request('/api/settings', 'PATCH', { workMode: before.settings.workMode, approvalPolicy: before.settings.approvalPolicy });
  }
});

test('browser inference connections route local replies without a server credential', async () => {
  const connection = await fetch(`http://127.0.0.1:${port}/api/on-device/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test browser model', deviceId: 'browser-12345678', models: [{ id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi mini', lowResource: true }] })
  });
  assert.equal(connection.status, 201);
  const provider = (await connection.json()).provider;
  assert.equal(provider.kind, 'browser-webllm');
  assert.equal(provider.browser, true);
  assert.equal(provider.hasKey, false);
  assert.doesNotMatch(JSON.stringify(provider), /apiKey|secret|token/i);

  const model = `provider:${provider.id}:Phi-3.5-mini-instruct-q4f16_1-MLC`;
  const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Browser test agent', transport: 'local-opencode', model }) });
  assert.equal(agentResponse.status, 201);
  const agent = (await agentResponse.json()).agent;
  const roomResponse = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Browser test room' }) });
  const room = (await roomResponse.json()).room;
  const userResponse = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/messages/user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Say hello locally.', agentIds: [agent.id] }) });
  assert.equal(userResponse.status, 200);
  const replyBody = { agentId: agent.id, content: 'Hello from the browser model.', inputTokens: 11, outputTokens: 6, replyId: 'save-retry-qa' };
  const postReply = body => fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/messages/browser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const browserResponse = await postReply(replyBody);
  assert.equal(browserResponse.status, 200);
  const browserBody = await browserResponse.json();
  assert.equal(browserBody.message.delivery, 'local-only');
  assert.equal(browserBody.message.transport, 'browser-webllm');
  assert.equal(browserBody.receipt.source, 'browser-webllm');
  const duplicate = await postReply(replyBody);
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.alreadySaved, true);
  assert.equal(duplicateBody.message.id, browserBody.message.id);
  assert.equal(duplicateBody.room.messages.filter(item => item.browserReplyId === replyBody.replyId).length, 1);
  assert.equal((await postReply({ ...replyBody, content: 'Changed reply' })).status, 409);
  assert.equal((await postReply({ ...replyBody, replyId: '<invalid>' })).status, 400);
  const usage = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json()).usage.find((item) => item.agentId === agent.id && item.source === 'browser-webllm');
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.outputTokens, 6);
  assert.equal(usage.estimated, false);
  const failed = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/messages/browser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, error: 'The browser could not prepare the local model. Check connection and storage, then retry.' }) });
  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  assert.equal(failedBody.message.role, 'system');
  assert.equal(failedBody.message.delivery, 'local-only');
  assert.equal(failedBody.message.transport, 'browser-webllm');
  assert.match(failedBody.message.content, /^On-device model unavailable: The browser could not prepare the local model/);
  assert.equal(failedBody.receipt.status, 'failed');
  assert.match(failedBody.receipt.detail, /Check connection and storage/);
  const afterFailure = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json());
  const persistedRoom = afterFailure.rooms.find((item) => item.id === room.id);
  assert.equal(persistedRoom.messages.at(-1).content, failedBody.message.content);
  const usages = afterFailure.usage.filter((item) => item.agentId === agent.id && item.source === 'browser-webllm');
  assert.equal(usages.length, 1, 'failed local inference does not create a usage record');
  assert.equal(afterFailure.receipts.filter(item => item.agentId === agent.id && item.source === 'browser-webllm' && item.status === 'completed').length, 1, 'save retries do not duplicate receipts');
  await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: [] }) });
  const outsiderResponse = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/messages/browser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, content: 'Should be blocked after membership changes.' }) });
  assert.equal(outsiderResponse.status, 403);
  await removeTestAgent(agent.id);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/providers/${provider.id}`, { method: 'DELETE' })).status, 200);
});

test('autonomous tasks are real persisted work items and respect the active mode', async () => {
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workMode: 'converse', approvalPolicy: 'review' }) });
  const createAgent = await fetch(`http://127.0.0.1:${port}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Task agent', transport: 'local-opencode' }) });
  const agent = (await createAgent.json()).agent;
  const createTask = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bounded test', agentId: agent.id, prompt: 'Return one short status line.', maxRuns: 1 }) });
  assert.equal(createTask.status, 201);
  const task = (await createTask.json()).task;
  assert.equal(task.status, 'paused');
  const start = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'running' }) });
  assert.equal(start.status, 403);
  const deniedStart = await start.json();
  assert.equal(deniedStart.denied, true);
  assert.match(deniedStart.error, /Converse mode does not permit spawn_subagents/i);
  const deniedRun = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(deniedRun.status, 403);
  const deniedRunBody = await deniedRun.json();
  assert.equal(deniedRunBody.denied, true);
  assert.match(deniedRunBody.error, /Converse mode does not permit spawn_subagents/i);
  await removeTestAgent(agent.id);
});

test('task approvals are bounded, redacted, expiring, and cancellable', async () => {
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workMode: 'build', approvalPolicy: 'ask' }) });
  const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Approval agent', transport: 'local-opencode' }) });
  const agent = (await agentResponse.json()).agent;
  const taskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Private approval task', agentId: agent.id, prompt: 'SECRET PRIVATE PROMPT MUST NOT ENTER APPROVAL REQUESTS', maxRuns: 1 }) });
  const task = (await taskResponse.json()).task;
  const pendingResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(pendingResponse.status, 409);
  const pending = await pendingResponse.json();
  assert.equal(pending.request.target, 'Private approval task');
  assert.deepEqual(pending.request.scopes, ['schedule', 'selected agent']);
  assert.doesNotMatch(JSON.stringify(pending), /SECRET PRIVATE PROMPT/);
  const inbox = await (await fetch(`http://127.0.0.1:${port}/api/approvals`)).json();
  assert.equal(inbox.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(inbox), /SECRET PRIVATE PROMPT/);
  const cancelled = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/approvals`)).json()).requests, []);
  await removeTestAgent(agent.id);
});

test('local authentication creates a session and protects private bootstrap data', async () => {
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local-test-passphrase' })
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  ownerSessionCookie = cookie;
  const locked = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  assert.equal(locked.status, 401);
  assert.equal((await locked.json()).authRequired, true);
  const unlocked = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { cookie } });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.headers.get('content-type').includes('application/json'), true);

  const updated = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'converse' })
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.deepEqual(updatedBody.settings.auth, { configured: true, provider: 'local', googleLinked: false, localPasscode: true });
  for (const forbidden of ['hash', 'salt', 'recoveryHash', 'recoverySalt', 'googleSubject', 'googleEmail']) {
    assert.equal(JSON.stringify(updatedBody).includes(forbidden), false, `${forbidden} must never enter a settings response`);
  }
});

test('agent removal preserves saved memories until the owner handles them', async () => {
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'build' }) });
  const request = async (pathname, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: ownerSessionCookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, ...await response.json() };
  };
  const { agent } = await request('/api/agents', 'POST', { name: 'Memory removal guard', transport: 'local-opencode' });
  const { memory } = await request(`/api/agents/${agent.id}/memories`, 'POST', { content: 'Keep this memory.' });
  const denied = await request(`/api/agents/${agent.id}`, 'DELETE');
  assert.equal(denied.status, 409);
  assert.match(denied.error, /saved memories/i);
  assert.equal((await request(`/api/agents/${agent.id}/memories`, 'GET')).memories[0].id, memory.id);
  assert.equal((await request(`/api/memories/${memory.id}`, 'DELETE', { expectedRevision: 0 })).status, 200);
  assert.equal((await request(`/api/agents/${agent.id}`, 'DELETE', { approved: true })).status, 200);
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'converse' }) });
});

test('owner memory API commits revisions and exposes bounded recall depths', async () => {
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'build' }) });
  const request = async (pathname, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: ownerSessionCookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, ...await response.json() };
  };
  const { agent } = await request('/api/agents', 'POST', { name: 'Memory revision probe', transport: 'local-opencode' });
  const added = await request(`/api/agents/${agent.id}/memories`, 'POST', { content: 'Test mode', valid_while: 'registration is pending', verify_by: '2020-01-01', evidence_excerpt: 'Owner note', verification: 'owner-confirmed' });
  assert.equal(added.status, 201);
  assert.match(added.memory.id, /^memory-[0-9a-f-]{36}$/);
  assert.equal(added.memory.status, 'active');
  assert.equal(added.memory.verification, 'unverified', 'creating an owner note cannot forge confirmation');
  assert.equal(added.memory.verify_by, '2020-01-01');
  assert.equal((await request(`/api/agents/${agent.id}/memories`, 'POST', { content: 'Bad date', verify_by: '2026-02-30' })).status, 400);
  const paired = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/?pair=ABCDEF12',
      headers: { host: `192.0.2.10:${port}` } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(paired.statusCode, 302);
  const pairedCookie = paired.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  const pairedHeaders = { 'content-type': 'application/json', host: `192.0.2.10:${port}`, cookie: pairedCookie };
  const pairedStatus = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: pairedHeaders });
  assert.equal((await pairedStatus.json()).paired, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/memory-proposals`, { headers: pairedHeaders })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/memory-proposals/memory-proposal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/decision`, { method: 'POST', headers: pairedHeaders, body: JSON.stringify({ decision: 'approve' }) })).status, 403);
  for (const [pathname, method, body] of [
    [`/api/agents/${agent.id}/memories`, 'POST', { content: 'Paired write must fail' }],
    [`/api/memories/${added.memory.id}`, 'PATCH', { content: 'Paired revision must fail', reason: 'Untrusted' }],
    [`/api/memories/${added.memory.id}`, 'DELETE', null]
  ]) {
    const deniedPair = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: pairedHeaders, body: body === null ? undefined : JSON.stringify(body) });
    assert.equal(deniedPair.status, 403);
  }
  const missingReason = await request(`/api/memories/${added.memory.id}`, 'PATCH', { content: 'Live mode', expectedRevision: 0 });
  assert.equal(missingReason.status, 400);
  const changed = await request(`/api/memories/${added.memory.id}`, 'PATCH', { content: 'Live mode', status: 'conditional', valid_while: 'registration is active', reason: 'Owner finished registration', expectedRevision: 0 });
  assert.equal(changed.status, 200);
  assert.equal(changed.memory.id, added.memory.id);
  assert.deepEqual(changed.memory.revisions[0].changes.content, { from: 'Test mode', to: 'Live mode' });
  const current = await request(`/api/agents/${agent.id}/memories?depth=0`, 'GET');
  assert.equal(current.memories[0].valid_while, 'registration is active');
  assert.equal(current.memories[0].stale, true);
  assert.equal('revisions' in current.memories[0], false);
  const history = await request(`/api/agents/${agent.id}/memories?depth=1`, 'GET');
  assert.equal(history.memories[0].revisions.length, 1);
  assert.equal('evidence_excerpt' in history.memories[0], false);
  const evidence = await request(`/api/agents/${agent.id}/memories?depth=2`, 'GET');
  assert.equal(evidence.memories[0].evidence_excerpt, 'Owner note');
  const confirmPath = `/api/memories/${added.memory.id}/confirm`;
  const confirmation = { expectedRevision: 1, why: 'Owner checked the current registration record.', approved: true };
  assert.equal((await fetch(`http://127.0.0.1:${port}${confirmPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(confirmation)
  })).status, 401, 'an unauthenticated browser cannot confirm a note');
  assert.equal((await fetch(`http://127.0.0.1:${port}${confirmPath}`, {
    method: 'POST', headers: pairedHeaders, body: JSON.stringify(confirmation)
  })).status, 403, 'a paired browser is not an owner session');
  assert.equal((await request(confirmPath, 'POST', { ...confirmation, approved: false })).status, 400);
  assert.equal((await request(confirmPath, 'POST', { ...confirmation, expectedRevision: 0 })).status, 400,
    'confirmation must bind the current note revision');
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'plan' }) });
  assert.equal((await request(confirmPath, 'POST', confirmation)).status, 403, 'Plan mode cannot confirm a note');
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'build' }) });
  const confirmed = await request(confirmPath, 'POST', confirmation);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.memory.verification, 'owner-confirmed');
  assert.equal(confirmed.memory.revisions.length, 2);
  assert.deepEqual(confirmed.memory.revisions[1].changes, { verification: { from: 'unverified', to: 'owner-confirmed' } });
  assert.equal((await request(`/api/agents/${agent.id}/memories?depth=0`, 'GET')).memories[0].verification, 'owner-confirmed');
  assert.equal((await request(`/api/memories/${added.memory.id}`, 'PATCH', {
    content: 'Stale overwrite', reason: 'Stale form', expectedRevision: 1
  })).status, 409, 'a stale note edit cannot erase confirmation history');
  const afterConfirmationEdit = await request(`/api/memories/${added.memory.id}`, 'PATCH', {
    content: 'Live mode was updated.', reason: 'Owner revised the remembered fact.', expectedRevision: 2
  });
  assert.equal(afterConfirmationEdit.status, 200);
  assert.equal(afterConfirmationEdit.memory.verification, 'unverified', 'a content edit invalidates the confirmation');
  assert.equal(afterConfirmationEdit.memory.revisions.length, 3);
  assert.equal((await request(`/api/agents/${agent.id}/memories?depth=0`, 'GET')).memories[0].verification, 'unverified');
  assert.equal((await request(`/api/memories/${added.memory.id}`, 'DELETE', { expectedRevision: 2 })).status, 409,
    'a stale removal cannot erase a newer note revision');
  const removed = await request(`/api/memories/${added.memory.id}`, 'DELETE', { expectedRevision: 3 });
  assert.equal(removed.status, 200);
  assert.equal(removed.memory.status, 'historical');
  assert.equal(removed.memory.revisions.length, 4);
  const receipts = (await request('/api/bootstrap', 'GET')).receipts;
  assert.equal(receipts.some((item) => item.action === 'memory:confirm-owner-note'), true);
  assert.equal(JSON.stringify(receipts).includes(confirmation.why), false);
  assert.equal(JSON.stringify(receipts).includes('Live mode was updated.'), false);
  assert.deepEqual((await request(`/api/agents/${agent.id}/memories?depth=0`, 'GET')).memories, []);
  assert.equal((await request(`/api/agents/${agent.id}/memories?manage=1`, 'GET')).memories[0].id, added.memory.id);
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'plan' }) });
  assert.equal((await request(`/api/agents/${agent.id}/memories`, 'POST', { content: 'Blocked in Plan' })).status, 403);
  assert.equal((await request(`/api/memories/${added.memory.id}`, 'PATCH', { status: 'active', reason: 'Blocked in Plan' })).status, 403);
  assert.equal((await request(`/api/memories/${added.memory.id}`, 'DELETE')).status, 403);
  assert.equal((await request(`/api/agents/${agent.id}/memories?manage=1`, 'GET')).memories[0].status, 'historical');
  assert.equal((await request(`/api/agents/${agent.id}`, 'DELETE', { approved: true })).status, 403, 'Plan mode also blocks profile deletion');
  await removeTestAgent(agent.id);
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ownerSessionCookie }, body: JSON.stringify({ workMode: 'converse' }) });
});

test('owner links two exact scoped facts and can inspect both conflict sides', async () => {
  const call = async (pathname, method = 'GET', body, cookie = ownerSessionCookie) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  await call('/api/settings', 'PATCH', { workMode: 'build' });
  const { agent } = await call('/api/agents', 'POST', { name: 'Conflict owner probe', transport: 'local-opencode' });
  const route = `/api/agents/${agent.id}/memory-commit`;
  const scope = { projectId: 'conflict-owner-qa' };
  const first = await call(route, 'POST', { operation: 'create', text: 'The service is in test mode.', contextScope: scope, verify_by: '2020-01-01' });
  const second = await call(route, 'POST', { operation: 'create', text: 'The service is live.', contextScope: scope });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const ownerFact = `/api/agents/${agent.id}/memory-facts/${first.id}`;
  assert.equal((await call(ownerFact, 'GET', undefined, '')).status, 401);
  const unlinked = await call(ownerFact);
  assert.equal(unlinked.memory.stale, true);
  assert.match(unlinked.memory.warning, /STALE/);
  const wrongScope = await call(route, 'POST', { operation: 'create', text: 'Other scope.', contextScope: { projectId: 'unrelated' } });
  assert.equal(wrongScope.status, 201);
  const evidence = { kind: 'owner-feedback', text: 'I reviewed the current service status in the owner console.' };
  assert.equal((await call(route, 'POST', { operation: 'conflict', fromId: first.id, toId: wrongScope.id,
    relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0, why: 'Different scopes cannot conflict here.', source: evidence, approved: true })).status, 400);
  const linked = await call(route, 'POST', { operation: 'conflict', fromId: first.id, toId: second.id,
    relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0, why: 'Owner observed incompatible status facts.', source: evidence, approved: true });
  assert.equal(linked.status, 201);
  const left = (await call(ownerFact)).memory;
  const right = (await call(`/api/agents/${agent.id}/memory-facts/${second.id}`)).memory;
  assert.equal(left.text, 'The service is in test mode.');
  assert.equal(right.text, 'The service is live.');
  assert.equal(left.conflicts[0].otherId, second.id);
  assert.equal(right.conflicts[0].otherId, first.id);
  assert.match(left.warning, /CONFLICT/);
  assert.match(right.warning, /CONFLICT/);
  const history = (await call(`${ownerFact}?depth=1`)).memory;
  assert.equal(history.conflicts[0].evidence.text, undefined);
  const full = (await call(`${ownerFact}?depth=2`)).memory;
  assert.equal(full.conflicts[0].evidence.text, evidence.text);
  await call('/api/settings', 'PATCH', { workMode: 'converse' });
});

test('HexiSpace scheduled work stays paused, bounded, private, and isolated to its approved link', async () => {
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local-test-passphrase' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'HexiSpace schedule test', transport: 'local-opencode' })
  });
  assert.equal(agentResponse.status, 201);
  const agent = (await agentResponse.json()).agent;
  const schedulePolicy = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'watch', approvalPolicy: 'full' })
  });
  assert.equal(schedulePolicy.status, 200);

  async function connectScheduledWork() {
    const pairingResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/pairing`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'http://127.0.0.1:4340', scopes: ['scheduled_work'] })
    });
    assert.equal(pairingResponse.status, 201);
    const pairing = await pairingResponse.json();
    const approval = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/pairing/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code: pairing.code, scopes: ['scheduled_work'] })
    });
    assert.equal(approval.status, 201);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/pairing/status?id=${encodeURIComponent(pairing.id)}`);
    assert.equal(statusResponse.status, 200);
    return (await statusResponse.json()).token;
  }

  const firstToken = await connectScheduledWork();
  const scheduleAsk = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'watch', approvalPolicy: 'ask' })
  });
  assert.equal(scheduleAsk.status, 200);
  const selfApprovedSchedule = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${firstToken}` },
    body: JSON.stringify({ agentId: agent.id, name: 'Must stay blocked', prompt: 'This should not be created by a connector self-approval.', approved: true })
  });
  assert.equal(selfApprovedSchedule.status, 409);
  assert.equal((await selfApprovedSchedule.json()).approvalRequired, true);
  const scheduleFull = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'watch', approvalPolicy: 'full' })
  });
  assert.equal(scheduleFull.status, 200);
  const taskResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${firstToken}` },
    body: JSON.stringify({ agentId: agent.id, name: 'Review carefully', prompt: 'Keep this private task prompt out of list responses.', intervalSeconds: 1, maxRuns: 10000, maxRetries: 99 })
  });
  assert.equal(taskResponse.status, 201);
  const created = await taskResponse.json();
  assert.deepEqual(created.task, { id: created.task.id, name: 'Review carefully', status: 'paused' });
  assert.match(created.notice, /paused/i);

  const firstListResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks`, { headers: { authorization: `Bearer ${firstToken}` } });
  assert.equal(firstListResponse.status, 200);
  assert.equal(firstListResponse.headers.get('cache-control'), 'no-store');
  const listed = await firstListResponse.json();
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].intervalSeconds, 900);
  assert.equal(listed.tasks[0].maxRuns, 100);
  assert.equal(listed.tasks[0].status, 'paused');
  assert.doesNotMatch(JSON.stringify(listed), /Keep this private|lastOutput|lastError|connectorId/);

  const secondToken = await connectScheduledWork();
  const secondList = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks`, { headers: { authorization: `Bearer ${secondToken}` } });
  assert.deepEqual((await secondList.json()).tasks, []);
  const crossLinkCancel = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks/${created.task.id}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secondToken}` }, body: '{}'
  });
  assert.equal(crossLinkCancel.status, 404);

  const cancel = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks/${created.task.id}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${firstToken}` }, body: '{}'
  });
  assert.equal(cancel.status, 200);
  assert.deepEqual((await cancel.json()).task, { id: created.task.id, status: 'cancelled' });
  const cancelled = await (await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/tasks`, { headers: { authorization: `Bearer ${firstToken}` } })).json();
  assert.equal(cancelled.tasks[0].status, 'cancelled');
  await removeTestAgent(agent.id);
});

test('HexiSpace artifacts require consent, stay scoped, expire through links, and download safely', async () => {
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local-test-passphrase' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const pairingResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/pairing`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'http://127.0.0.1:4340', scopes: ['artifacts'] })
  });
  const pairing = await pairingResponse.json(); assert.equal(pairingResponse.status, 201);
  const approval = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/pairing/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ code: pairing.code, scopes: ['artifacts'] })
  });
  assert.equal(approval.status, 201);
  const status = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/pairing/status?id=${encodeURIComponent(pairing.id)}`);
  const token = (await status.json()).token; assert.ok(token);
  const policy = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'build', approvalPolicy: 'ask' })
  });
  assert.equal(policy.status, 200);
  const contentBase64 = Buffer.from('artifact text').toString('base64');
  const missingConsent = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename: 'note.txt', mimeType: 'text/plain', contentBase64 })
  });
  assert.equal(missingConsent.status, 409);
  assert.equal((await missingConsent.json()).approvalRequired, true);
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename: '../../note.txt', mimeType: 'text/plain', contentBase64, consent: true, approved: true, expiresInSeconds: 300 })
  });
  assert.equal(createdResponse.status, 409);
  assert.equal((await createdResponse.json()).approvalRequired, true);
  const fullPolicy = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'build', approvalPolicy: 'full' })
  });
  assert.equal(fullPolicy.status, 200);
  const approvedResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename: '../../note.txt', mimeType: 'text/plain', contentBase64, consent: true, approved: true, expiresInSeconds: 300 })
  });
  const createdText = await approvedResponse.text();
  assert.equal(approvedResponse.status, 201, createdText);
  const created = JSON.parse(createdText);
  assert.equal(created.artifact.filename, 'note.txt');
  assert.equal(created.artifact.bytes, 13);
  assert.equal(JSON.stringify(created.quota).includes(token), false);
  const downloadUrl = `http://127.0.0.1:${port}${created.artifact.downloadUrl}`;
  const previewUrl = `http://127.0.0.1:${port}${created.artifact.previewUrl}`;
  const download = await fetch(downloadUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="note.txt"');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await download.text(), 'artifact text');
  const preview = await fetch(previewUrl, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).preview, { kind: 'text', text: 'artifact text', truncated: false });
  const askDeletePolicy = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'build', approvalPolicy: 'ask' })
  });
  assert.equal(askDeletePolicy.status, 200);
  const selfApprovedDelete = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts/${created.artifact.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(selfApprovedDelete.status, 409);
  assert.equal((await selfApprovedDelete.json()).approvalRequired, true);
  const restoreDeletePolicy = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workMode: 'build', approvalPolicy: 'full' })
  });
  assert.equal(restoreDeletePolicy.status, 200);
  const deleted = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts/${created.artifact.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(downloadUrl)).status, 401);

  const providerResponse = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename: 'landing.html', mimeType: 'text/html', providerUrl: 'https://provider.example/landing.html', providerName: 'Example provider', consent: true, approved: true, expiresInSeconds: 300 })
  });
  assert.equal(providerResponse.status, 201);
  const provider = (await providerResponse.json()).artifact;
  assert.equal(provider.source, 'provider');
  assert.equal(provider.bytes, 0);
  assert.equal(provider.externalUrl, 'https://provider.example/landing.html');
  assert.equal('downloadUrl' in provider, false);
  const providerPreview = await fetch(`http://127.0.0.1:${port}${provider.previewUrl}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(providerPreview.status, 200);
  assert.deepEqual((await providerPreview.json()).preview, { kind: 'external-link', text: '', truncated: false });
  const providerDownload = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts/${provider.id}/download?token=${encodeURIComponent(provider.token)}`);
  assert.equal(providerDownload.status, 409);
  assert.equal((await providerDownload.json()).externalUrl, 'https://provider.example/landing.html');
  const providerDeleted = await fetch(`http://127.0.0.1:${port}/api/hexispace/v1/artifacts/${provider.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(providerDeleted.status, 200);
});

test('owner entity registry route requires explicit owner approval and keeps labels out of receipts', async () => {
  const request = async (pathname, method, body, cookie = ownerSessionCookie) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, ...await response.json() };
  };
  await request('/api/settings', 'PATCH', { workMode: 'build' });
  try {
    const createdAgent = await request('/api/agents', 'POST', { name: 'Entity registry route probe', transport: 'local-opencode' });
    assert.equal(createdAgent.status, 201);
    const pathname = `/api/agents/${createdAgent.agent.id}/memory-entities`;
    const create = { operation: 'create', label: 'North Harbor', entityType: 'project', projectId: 'entity-qa', why: 'Owner verified this project name.', approved: true };
    assert.equal((await request(pathname, 'POST', create, '')).status, 401);
    assert.equal((await request(pathname, 'POST', { ...create, approved: false })).status, 409);
    await request('/api/settings', 'PATCH', { workMode: 'plan' });
    assert.equal((await request(pathname, 'POST', create)).status, 403);
    await request('/api/settings', 'PATCH', { workMode: 'build' });
    const committed = await request(pathname, 'POST', create);
    assert.equal(committed.status, 201, JSON.stringify(committed));
    assert.equal(committed.entity.label, 'North Harbor');
    assert.equal(committed.entity.status, 'confirmed');
    const listed = await request(pathname, 'GET');
    assert.equal(listed.status, 200);
    assert.ok(listed.entities.some((entity) => entity.id === committed.entity.id));
    const added = await request(pathname, 'POST', { operation: 'alias-add', entityId: committed.entity.id,
      expectedRevision: committed.entity.revision, alias: 'Harbor Project', why: 'Owner uses this alternate name.', approved: true });
    assert.equal(added.status, 200, JSON.stringify(added));
    assert.ok(added.entity.aliases.includes('Harbor Project'));
    const history = await request(`${pathname}/${encodeURIComponent(committed.entity.id)}/history?limit=50`, 'GET');
    assert.equal(history.status, 200, JSON.stringify(history));
    assert.deepEqual(history.events.map((event) => event.action), ['create', 'alias-add']);
    assert.ok(history.events.every((event) => event.by?.startsWith('owner:') && event.why && event.audit?.hash));
    const stale = await request(pathname, 'POST', { operation: 'alias-add', entityId: committed.entity.id,
      expectedRevision: committed.entity.revision, alias: 'Old Revision', why: 'Stale update probe.', approved: true });
    assert.equal(stale.status, 400);
    const bootstrap = await request('/api/bootstrap', 'GET');
    assert.doesNotMatch(JSON.stringify(bootstrap.receipts), /North Harbor|Harbor Project/);
  } finally {
    await request('/api/settings', 'PATCH', { workMode: 'converse' });
  }
});
