import path from 'node:path';
import { pathToFileURL } from 'node:url';

const realProcess = globalThis.process;
const rawWrite = realProcess.stdout.write.bind(realProcess.stdout);
const [, pluginDirectory, entry] = realProcess.argv;
if (!pluginDirectory || !entry) realProcess.exit(2);

const target = path.resolve(pluginDirectory, entry);
if (!target.startsWith(`${path.resolve(pluginDirectory)}${path.sep}`)) throw new Error('Plugin entry escaped its immutable package.');

const pending = new Map();
let sequence = 0;
function send(message) { rawWrite(`${JSON.stringify(message)}\n`); }
function broker(operation, args) {
  const id = `request-${++sequence}`;
  send({ type: 'broker', id, operation, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const api = Object.freeze({
  files: Object.freeze({
    readText: (file) => broker('files.readText', { path: file }),
    writeText: (file, content) => broker('files.writeText', { path: file, content })
  }),
  network: Object.freeze({ request: (request) => broker('network.request', request || {}) })
});

for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: undefined });
}
const processFacade = Object.freeze({
  platform: realProcess.platform,
  versions: Object.freeze({ node: realProcess.versions.node }),
  env: Object.freeze({}), argv: Object.freeze([]), cwd: () => '/',
  exit: () => { throw new Error('Plugins cannot terminate the host process.'); },
  kill: () => { throw new Error('Plugins cannot signal processes.'); }
});
Object.defineProperty(globalThis, 'process', { configurable: false, writable: false, value: processFacade });
Object.defineProperty(globalThis, 'hexigrid', { configurable: false, writable: false, value: api });
let invoked = false;
let inputBuffer = '';
async function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return send({ type: 'error', error: 'Invalid host protocol.' }); }
  if (message.type === 'broker-result') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.ok ? request.resolve(message.result) : request.reject(new Error(message.error || 'Broker request failed.'));
    return;
  }
  if (message.type !== 'invoke' || invoked) return send({ type: 'error', error: 'Invalid invocation sequence.' });
  invoked = true;
  try {
    const module = await import(pathToFileURL(target).href);
    const run = module.capabilities?.[message.capability] || module.run || module.default;
    if (typeof run !== 'function') throw new Error('Plugin entry does not export the declared capability.');
    const result = await run(message.input || {}, Object.freeze({ capability: message.capability, hexigrid: api }));
    send({ type: 'result', result: result ?? null });
  } catch (error) { send({ type: 'error', error: String(error?.message || error).slice(0, 1000) }); }
}
realProcess.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString();
  let boundary;
  while ((boundary = inputBuffer.indexOf('\n')) >= 0) {
    const line = inputBuffer.slice(0, boundary); inputBuffer = inputBuffer.slice(boundary + 1);
    if (line) handleLine(line);
  }
});
