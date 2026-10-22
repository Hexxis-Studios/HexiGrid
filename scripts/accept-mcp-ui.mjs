// Disposable current-source owner MCP visual fixture. No real Link or data.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mcp-visual-'));
const service = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const rpc = JSON.parse(raw);
  if (rpc.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-visual-mcp', version: '1' } };
  if (rpc.method === 'tools/list') result = { tools: [
    { name: 'echo', description: 'Echo harmless text without file or external network access.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, payload: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false } }, required: ['text'], additionalProperties: false } },
    { name: 'fail', description: 'Return an intentional error to verify recovery.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ] };
  if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: rpc.params.arguments.text || '' }], ...(rpc.params.arguments.payload ? { structuredContent: rpc.params.arguments.payload } : {}) };
  res.setHeader('content-type', 'application/json');
  if (rpc.method === 'tools/call' && rpc.params.name === 'fail') res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -1, message: 'Synthetic MCP failure; retry using echo.' } }));
  else res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
let app, cookie = '', stopped = false;
async function stop() {
  if (stopped) return; stopped = true;
  if (app && app.exitCode === null) { const exit = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exit; }
  if (service.listening) await new Promise(resolve => service.close(resolve));
  if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('hexigrid-mcp-visual-')) throw Error('Disposable cleanup path changed.');
  await rm(dataDir, { recursive: true, force: true });
}
process.on('SIGINT', () => stop().then(() => process.exit()));
process.on('SIGTERM', () => stop().then(() => process.exit()));
async function call(route, method, body) {
  const res = await fetch('http://127.0.0.1:44758' + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw Error(`Synthetic MCP setup failed: ${route} ${res.status}`);
  return res;
}
try {
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(3001, '127.0.0.1', resolve); });
  app = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44758', HEXIGRID_AGENT_RELAY_PORT: '44759', HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44759', HEXIGRID_DATA_DIR: dataDir, OPENCODE_CLI: 'missing-mcp-visual-model' } });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (app.exitCode !== null) throw Error('Synthetic MCP host exited.');
    try { if ((await fetch('http://127.0.0.1:44758')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw Error('Synthetic MCP host unavailable.');
  cookie = (await call('/api/auth/setup', 'POST', { password: 'public-disposable-QA-fixture-only' })).headers.get('set-cookie').split(';')[0];
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  await call('/api/mcp', 'POST', { name: 'QA echo tools', transport: 'http', url: 'http://127.0.0.1:3001/mcp' });
  await call('/api/settings', 'PATCH', { approvalPolicy: 'ask' });
  console.log('Disposable MCP UI ready at localhost44758; disabled synthetic tools, Ask policy, no real Link or model. Enter stop to clean up.');
  const input = readline.createInterface({ input: process.stdin });
  for await (const command of input) if (command === 'stop') { input.close(); await stop(); break; }
} catch (error) { await stop(); console.error(error.message); process.exitCode = 1; }
