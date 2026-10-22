import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPackageIdentity, createCapabilityBroker, installPluginPackage, runPluginCapability,
  validatePluginManifest, verifyInstalledPlugin
} from '../lib/plugin-security.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runnerPath = path.join(root, 'lib', 'plugin-runner.mjs');
let folder;
let pluginRoot;
let workspaceRoot;

before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-plugin-security-'));
  pluginRoot = path.join(folder, 'plugins');
  workspaceRoot = path.join(folder, 'workspace');
  await mkdir(pluginRoot); await mkdir(workspaceRoot);
});
after(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

function manifest(id, capability = {}) {
  return {
    schemaVersion: 2, id, name: id, version: '1.0.0', entry: 'plugin.mjs',
    capabilities: [{
      id: 'execute', label: 'Execute', risk: 'low',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: true },
      permissions: { files: { readRoots: [], writeRoots: [] }, network: [] },
      limits: { timeoutMs: 3000, memoryMb: 48, outputBytes: 32768, requestBytes: 32768, brokerRequests: 10, concurrency: 1 },
      ...capability
    }]
  };
}
async function install(id, source, capability = {}, extra = {}) {
  return installPluginPackage({ pluginRoot, manifest: { ...manifest(id, capability), ...extra }, files: [{ path: 'plugin.mjs', content: source }], trustMode: 'owner-local' });
}
async function run(plugin, input = {}, signal) {
  return runPluginCapability({ plugin, capability: plugin.capabilities[0], input, pluginRoot, workspaceRoot, runnerPath, signal, secretResolver: async () => '' });
}

test('version 2 package identity is deterministic and rejects unsigned implicit trust and traversal', async () => {
  const source = 'export async function run(){return {ok:true}}';
  const raw = manifest('identity-plugin');
  const first = buildPackageIdentity(raw, [{ path: 'plugin.mjs', content: source }]);
  const second = buildPackageIdentity(raw, [{ path: 'plugin.mjs', content: source }]);
  assert.equal(first.digest, second.digest);
  await assert.rejects(() => installPluginPackage({ pluginRoot, manifest: raw, files: [{ path: 'plugin.mjs', content: source }] }), /explicit confirmation/i);
  assert.throws(() => buildPackageIdentity(raw, [{ path: '../escape.mjs', content: source }]), /safe relative paths/i);
  assert.throws(() => validatePluginManifest({ ...raw, schemaVersion: 1 }), /requires schemaVersion 2/i);
});

test('Ed25519 publisher signatures and trusted-key pinning are enforced', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const source = 'export async function run(){return {signed:true}}';
  const unsigned = { ...manifest('signed-plugin'), publisher: { id: 'test-publisher', name: 'Test Publisher', publicKey: publicPem, signature: Buffer.from('pending').toString('base64') } };
  const identity = buildPackageIdentity(unsigned, [{ path: 'plugin.mjs', content: source }]);
  const signature = crypto.sign(null, Buffer.from(identity.digest), privateKey).toString('base64');
  const signed = { ...unsigned, package: identity.manifest.package, publisher: { ...unsigned.publisher, signature } };
  await assert.rejects(() => installPluginPackage({ pluginRoot, manifest: signed, files: [{ path: 'plugin.mjs', content: source }] }), (error) => error.code === 'PUBLISHER_TRUST_REQUIRED');
  const installed = await installPluginPackage({ pluginRoot, manifest: signed, files: [{ path: 'plugin.mjs', content: source }], trustedPublisherKey: publicPem });
  assert.equal(installed.trust, 'signed-publisher');
  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await assert.rejects(() => installPluginPackage({ pluginRoot, manifest: signed, files: [{ path: 'plugin.mjs', content: source }], trustedPublisherKey: otherKey }), /trusted publisher key/i);
  signed.publisher.signature = Buffer.from('bad').toString('base64');
  await assert.rejects(() => installPluginPackage({ pluginRoot, manifest: signed, files: [{ path: 'plugin.mjs', content: source }], trustedPublisherKey: publicPem }), /signature is invalid/i);
});

test('immutable package verification detects file, manifest, extra-file, and symlink tampering', async (t) => {
  const plugin = await install('tamper-plugin', 'export async function run(){return {ok:true}}');
  assert.equal((await verifyInstalledPlugin(plugin, pluginRoot)).ok, true);
  const directory = path.join(pluginRoot, ...plugin.installPath.split('/'));
  await writeFile(path.join(directory, 'plugin.mjs'), 'export async function run(){return {changed:true}}');
  assert.equal((await verifyInstalledPlugin(plugin, pluginRoot)).ok, false);

  const extra = await install('extra-plugin', 'export async function run(){return {ok:true}}');
  const extraDirectory = path.join(pluginRoot, ...extra.installPath.split('/'));
  await writeFile(path.join(extraDirectory, 'extra.mjs'), 'export default 1');
  assert.equal((await verifyInstalledPlugin(extra, pluginRoot)).ok, false);

  const linked = await install('symlink-plugin', 'export async function run(){return {ok:true}}');
  const linkedDirectory = path.join(pluginRoot, ...linked.installPath.split('/'));
  const outside = path.join(folder, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'payload.mjs'), 'export default 1');
  try { await symlink(outside, path.join(linkedDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating test symlinks is not permitted on this Windows host.'); throw error; }
  assert.match((await verifyInstalledPlugin(linked, pluginRoot)).error, /symbolic links/i);
});

test('capability broker enforces exact file roots, blocks traversal and symlinks, and emits receipts', async () => {
  await mkdir(path.join(workspaceRoot, 'allowed')); await mkdir(path.join(workspaceRoot, 'blocked'));
  await writeFile(path.join(workspaceRoot, 'allowed', 'note.txt'), 'safe');
  const capability = validatePluginManifest(manifest('broker-files', {
    risk: 'none', permissions: { files: { readRoots: ['allowed'], writeRoots: ['allowed/output'] }, network: [] }
  })).capabilities[0];
  assert.equal(capability.risk, 'medium');
  const broker = createCapabilityBroker({ capability, workspaceRoot });
  assert.equal(await broker.dispatch('files.readText', { path: 'allowed/note.txt' }), 'safe');
  await broker.dispatch('files.writeText', { path: 'allowed/output/result.txt', content: 'done' });
  assert.equal(await readFile(path.join(workspaceRoot, 'allowed', 'output', 'result.txt'), 'utf8'), 'done');
  await assert.rejects(() => broker.dispatch('files.readText', { path: 'blocked/no.txt' }), /outside its declared roots/i);
  await assert.rejects(() => broker.dispatch('files.readText', { path: '../outside.txt' }), /safe workspace-relative/i);
  assert.equal(broker.receipts.filter((item) => item.status === 'completed').length, 2);
  assert.equal(broker.receipts.filter((item) => item.status === 'denied').length, 2);
  const policyBroker = createCapabilityBroker({ capability, workspaceRoot, authorize: async ({ policyCapability }) => { if (policyCapability === 'write_workspace') throw new Error('Active mode denies writes.'); } });
  await assert.rejects(() => policyBroker.dispatch('files.writeText', { path: 'allowed/output/denied.txt', content: 'no' }), /denies writes/i);
  assert.equal(policyBroker.receipts[0].status, 'denied');
});

test('network broker pins origin, path, method, headers, secrets, response size, and receipts', async () => {
  let captured;
  let resolverContext;
  const authorizationCalls = [];
  const capability = validatePluginManifest({ ...manifest('broker-network', {
    permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://api.example.test', methods: ['POST'], pathPrefix: '/v1/', secretHeaders: [{ header: 'authorization', secret: 'api-token', prefix: 'Bearer ' }] }] }
  }), secrets: [{ id: 'api-token', label: 'API token' }] }).capabilities[0];
  assert.equal(capability.risk, 'high');
  const fetchImpl = async (url, options) => {
    assert.equal(authorizationCalls.length, 3, 'authorize is rechecked immediately before fetch');
    captured = { url: String(url), ...options };
    return new Response('vault-secret accepted', { status: 200, headers: { 'content-type': 'text/plain', etag: 'vault-secret', 'set-cookie': 'never-return-this' } });
  };
  const broker = createCapabilityBroker({ capability, workspaceRoot, secretResolver: async (secretId, context) => {
    assert.equal(secretId, 'api-token');
    resolverContext = context;
    return 'vault-secret';
  }, fetchImpl, authorize: async context => { authorizationCalls.push(context); } });
  const result = await broker.dispatch('network.request', { url: 'https://api.example.test/v1/jobs', method: 'POST', headers: { accept: 'text/plain' }, body: 'work' });
  assert.equal(captured.headers.authorization, 'Bearer vault-secret');
  assert.equal(JSON.stringify(result).includes('vault-secret'), false);
  assert.match(result.body, /\[REDACTED\]/);
  assert.equal(result.headers.etag, '[REDACTED]');
  assert.equal(JSON.stringify(result).includes('never-return-this'), false);
  assert.equal(Object.isFrozen(resolverContext), true);
  assert.deepEqual({ operation: resolverContext.operation, url: resolverContext.url, method: resolverContext.method,
    header: resolverContext.header, prefix: resolverContext.prefix, capabilityId: resolverContext.capabilityId }, {
    operation: 'network.request', url: 'https://api.example.test/v1/jobs', method: 'POST',
    header: 'authorization', prefix: 'Bearer ', capabilityId: capability.id
  });
  assert.equal(resolverContext.signal instanceof AbortSignal, true);
  assert.equal(Object.hasOwn(resolverContext, 'secret'), false);
  assert.equal(authorizationCalls[1].url, 'https://api.example.test/v1/jobs');
  assert.equal(authorizationCalls[2].url, 'https://api.example.test/v1/jobs');
  await assert.rejects(() => broker.dispatch('network.request', { url: 'https://evil.example/v1/jobs', method: 'POST' }), /outside its declared destination/i);
  assert.equal(broker.receipts.at(-1).target.includes('query-secret'), false);
  await assert.rejects(() => broker.dispatch('network.request', { url: 'https://evil.example/v1/jobs?token=query-secret', method: 'POST' }), /outside its declared destination/i);
  assert.equal(broker.receipts.at(-1).target.includes('query-secret'), false);
  await assert.rejects(() => broker.dispatch('network.request', { url: 'https://api.example.test/v1/jobs', method: 'POST', headers: { authorization: 'stolen' } }), /cannot set/i);
  assert.equal(Object.hasOwn(broker.receipts.at(-1), 'detail'), false);
  assert.equal(broker.receipts.some((item) => item.status === 'completed'), true);
  assert.equal(broker.receipts.some((item) => item.status === 'denied'), true);
});

test('live host credentials expose only validated metadata and plugins cannot request that mode', async () => {
  const capability = validatePluginManifest({ ...manifest('broker-live-secret', {
    permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://api.example.test', methods: ['POST'], pathPrefix: '/v1/', secretHeaders: [{ header: 'authorization', secret: 'api-token', prefix: 'Bearer ' }] }] }
  }), secrets: [{ id: 'api-token', label: 'API token' }] }).capabilities[0];
  let fetchCalls = 0;
  const response = {
    status: 201,
    get ok() { throw new Error('destination ok must not be read'); },
    get headers() { throw new Error('destination headers echo bearer-token'); },
    get body() { throw new Error('destination body echoes partial bearer-token'); },
    text() { throw new Error('destination body text echoes encoded-bearer-token'); }
  };
  const broker = createCapabilityBroker({ capability, workspaceRoot,
    secretResolver: async () => Object.freeze({ value: 'bearer-token', responseMode: 'metadata-only' }),
    fetchImpl: async () => { fetchCalls += 1; return response; }
  });
  const result = await broker.dispatch('network.request', { url: 'https://api.example.test/v1/jobs?private=secret', method: 'POST' });
  assert.deepEqual(result, { status: 201, ok: true, headers: {}, body: '' });
  assert.equal(fetchCalls, 1);
  await assert.rejects(() => broker.dispatch('network.request', {
    url: 'https://api.example.test/v1/jobs', method: 'POST', responseMode: 'metadata-only'
  }), /cannot select a secret response mode/i);
  assert.equal(fetchCalls, 1, 'the host-only response contract cannot be selected through plugin arguments');

  const invalidBroker = createCapabilityBroker({ capability, workspaceRoot,
    secretResolver: async () => ({ value: 'bearer-token', responseMode: 'metadata-only', extra: 'untrusted' }),
    fetchImpl: async () => { throw new Error('invalid resolver result must not fetch'); }
  });
  await assert.rejects(invalidBroker.dispatch('network.request', {
    url: 'https://api.example.test/v1/jobs', method: 'POST'
  }), /credential-bound request failed/i);
});

test('broker rechecks authorization after deferred secret resolution and cancellation prevents fetch', async () => {
  const capability = validatePluginManifest({ ...manifest('broker-deferred-secret', {
    permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://api.example.test', methods: ['POST'], pathPrefix: '/v1/', secretHeaders: [{ header: 'authorization', secret: 'api-token', prefix: 'Bearer ' }] }] }
  }), secrets: [{ id: 'api-token', label: 'API token' }] }).capabilities[0];
  let releaseResolver;
  let startedResolver;
  const resolverStarted = new Promise(resolve => { startedResolver = resolve; });
  let revoked = false;
  let authorizationCalls = 0;
  let fetchCalls = 0;
  let context;
  const revokeBroker = createCapabilityBroker({ capability, workspaceRoot,
    secretResolver: (_id, receivedContext) => {
      context = receivedContext;
      startedResolver();
      return new Promise(resolve => { releaseResolver = resolve; });
    },
    authorize: async () => {
      authorizationCalls += 1;
      if (revoked) throw new Error('resolver supplied a private marker');
    },
    fetchImpl: async () => { fetchCalls += 1; return new Response('unexpected'); }
  });
  const pending = revokeBroker.dispatch('network.request', { url: 'https://api.example.test/v1/jobs?private-query=hidden-query', method: 'POST' });
  await resolverStarted;
  assert.equal(context.url, 'https://api.example.test/v1/jobs');
  assert.equal(context.url.includes('hidden-query'), false);
  assert.equal(Object.isFrozen(context), true);
  revoked = true;
  releaseResolver('hidden-secret');
  await assert.rejects(pending, /credential-bound request failed/i);
  assert.equal(authorizationCalls, 2, 'the second authorization check runs after resolution');
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(revokeBroker.receipts).includes('hidden-secret'), false);
  assert.equal(JSON.stringify(revokeBroker.receipts).includes('hidden-query'), false);

  let releaseCancelledResolver;
  let startCancelledResolver;
  let cancelledContext;
  const cancelledResolverStarted = new Promise(resolve => { startCancelledResolver = resolve; });
  const controller = new AbortController();
  const cancelBroker = createCapabilityBroker({ capability, workspaceRoot, signal: controller.signal,
    secretResolver: (_id, receivedContext) => {
      cancelledContext = receivedContext;
      startCancelledResolver();
      return new Promise(resolve => { releaseCancelledResolver = resolve; });
    }, fetchImpl: async () => { fetchCalls += 1; return new Response('unexpected'); }
  });
  const cancelled = cancelBroker.dispatch('network.request', { url: 'https://api.example.test/v1/jobs?private-query=hidden-query', method: 'POST' });
  await cancelledResolverStarted;
  controller.abort();
  await assert.rejects(cancelled, /cancelled/i);
  assert.equal(cancelledContext.signal.aborted, true);
  releaseCancelledResolver('hidden-secret');
  await Promise.resolve();
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(cancelBroker.receipts).includes('hidden-secret'), false);
  assert.equal(JSON.stringify(cancelBroker.receipts).includes('hidden-query'), false);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let resolverCalls = 0;
  const preAbortedBroker = createCapabilityBroker({ capability, workspaceRoot, signal: alreadyAborted.signal,
    secretResolver: async () => { resolverCalls += 1; return 'hidden-secret'; },
    fetchImpl: async () => { fetchCalls += 1; return new Response('unexpected'); }
  });
  await assert.rejects(preAbortedBroker.dispatch('network.request', { url: 'https://api.example.test/v1/jobs', method: 'POST' }), /cancelled/i);
  assert.equal(resolverCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('secret-bound resolver and fetch failures use fixed messages and content-free receipts', async () => {
  const capability = validatePluginManifest({ ...manifest('broker-secret-errors', {
    permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://api.example.test', methods: ['POST'], pathPrefix: '/v1/', secretHeaders: [{ header: 'authorization', secret: 'api-token', prefix: 'Bearer ' }] }] }
  }), secrets: [{ id: 'api-token', label: 'API token' }] }).capabilities[0];
  const resolverBroker = createCapabilityBroker({ capability, workspaceRoot,
    secretResolver: async () => { throw new Error('raw-vault-secret private-query'); },
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await assert.rejects(resolverBroker.dispatch('network.request', {
    url: 'https://api.example.test/v1/jobs?token=private-query', method: 'POST'
  }), /credential-bound request failed/i);
  assert.equal(JSON.stringify(resolverBroker.receipts).includes('raw-vault-secret'), false);
  assert.equal(JSON.stringify(resolverBroker.receipts).includes('private-query'), false);
  assert.equal(Object.hasOwn(resolverBroker.receipts[0], 'detail'), false);

  const fetchBroker = createCapabilityBroker({ capability, workspaceRoot,
    secretResolver: async () => 'raw-vault-secret',
    fetchImpl: async () => { throw new Error('transport raw-vault-secret private-query'); }
  });
  await assert.rejects(fetchBroker.dispatch('network.request', {
    url: 'https://api.example.test/v1/jobs?token=private-query', method: 'POST'
  }), /credential-bound request failed/i);
  assert.equal(JSON.stringify(fetchBroker.receipts).includes('raw-vault-secret'), false);
  assert.equal(JSON.stringify(fetchBroker.receipts).includes('private-query'), false);
});

test('runPluginCapability abort signal cancels an active broker fetch', async () => {
  const networkCapability = {
    permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://api.example.test', methods: ['POST'], pathPrefix: '/v1/', secretHeaders: [{ header: 'authorization', secret: 'api-token', prefix: 'Bearer ' }] }] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true }
  };
  const plugin = await install('runner-active-network-cancel',
    `export async function run(){return await hexigrid.network.request({url:'https://api.example.test/v1/jobs?private-query=hidden-query',method:'POST'})}`,
    networkCapability, { secrets: [{ id: 'api-token', label: 'API token' }] });
  let startFetch;
  const fetchStarted = new Promise(resolve => { startFetch = resolve; });
  let fetchSignal;
  const controller = new AbortController();
  const execution = runPluginCapability({ plugin, capability: plugin.capabilities[0], input: {}, pluginRoot, workspaceRoot,
    runnerPath, signal: controller.signal, secretResolver: async () => 'runner-secret',
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      startFetch();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error('runner-secret from transport'));
        options.signal.addEventListener('abort', fail, { once: true });
        if (options.signal.aborted) fail();
      });
    }
  });
  await fetchStarted;
  controller.abort();
  await assert.rejects(execution, /cancelled/i);
  assert.equal(fetchSignal.aborted, true);
});

test('runner timeout aborts deferred credential resolution and prevents later fetch', async () => {
  const networkCapability = {
    permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://api.example.test', methods: ['POST'], pathPrefix: '/v1/', secretHeaders: [{ header: 'authorization', secret: 'api-token', prefix: 'Bearer ' }] }] },
    limits: { timeoutMs: 800 },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true }
  };
  const plugin = await install('runner-timeout-during-secret-resolution',
    `export async function run(){return await hexigrid.network.request({url:'https://api.example.test/v1/jobs',method:'POST'})}`,
    networkCapability, { secrets: [{ id: 'api-token', label: 'API token' }] });
  let resolveStarted;
  const resolverStarted = new Promise(resolve => { resolveStarted = resolve; });
  let resolverSignal;
  let resolverAborted = false;
  let fetchCalls = 0;
  const execution = runPluginCapability({ plugin, capability: plugin.capabilities[0], input: {}, pluginRoot, workspaceRoot,
    runnerPath, secretResolver: (_id, context) => {
      resolverSignal = context.signal;
      resolveStarted();
      return new Promise(resolve => {
        const onAbort = () => { resolverAborted = true; resolve('late-secret'); };
        context.signal.addEventListener('abort', onAbort, { once: true });
        if (context.signal.aborted) onAbort();
      });
    },
    fetchImpl: async () => { fetchCalls += 1; return new Response('must not fetch'); }
  }).then(value => ({ value }), error => ({ error }));
  const race = await Promise.race([resolverStarted.then(() => 'resolver-started'), execution.then(() => 'execution-finished')]);
  assert.equal(race, 'resolver-started', 'runner reaches deferred host resolution before its deadline');
  const outcome = await execution;
  assert.match(outcome.error?.message || '', /timed out/i);
  assert.equal(resolverSignal.aborted, true);
  assert.equal(resolverAborted, true);
  assert.equal(fetchCalls, 0);
});

test('sandbox executes through broker while direct filesystem, network, process, worker, and environment access stay blocked', async () => {
  await mkdir(path.join(workspaceRoot, 'sandbox')); await writeFile(path.join(workspaceRoot, 'sandbox', 'input.txt'), 'hello');
  const capability = {
    permissions: { files: { readRoots: ['sandbox'], writeRoots: ['sandbox'] }, network: [] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true }
  };
  const brokered = await install('sandbox-broker', `export async function run(){const text=await hexigrid.files.readText('sandbox/input.txt');await hexigrid.files.writeText('sandbox/output.txt',text+' world');return {text,fetchType:typeof fetch,env:Object.keys(process.env)}}`, capability);
  const result = await run(brokered);
  assert.deepEqual(result.result, { text: 'hello', fetchType: 'undefined', env: [] });
  assert.equal(await readFile(path.join(workspaceRoot, 'sandbox', 'output.txt'), 'utf8'), 'hello world');
  assert.equal(result.brokerReceipts.length, 2);

  for (const [id, source] of [
    ['direct-fs', `export async function run(){await import('node:fs');return {ok:true}}`],
    ['direct-network', `export async function run(){await import('node:https');return {ok:true}}`],
    ['direct-process', `export async function run(){await import('node:child_process');return {ok:true}}`],
    ['direct-worker', `export async function run(){await import('node:worker_threads');return {ok:true}}`]
  ]) {
    const plugin = await install(id, source);
    await assert.rejects(() => run(plugin), /Plugin import blocked/i);
  }
});

test('sandbox enforces output schema, output limit, timeout, and cancellation', async () => {
  const wrongOutput = await install('wrong-output', 'export async function run(){return {count:"not-a-number"}}', {
    outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false }
  });
  await assert.rejects(() => run(wrongOutput), /must be number/i);

  const outputFlood = await install('output-flood', 'export async function run(){console.log("x".repeat(5000));return {ok:true}}', { limits: { outputBytes: 1024, timeoutMs: 2000 } });
  await assert.rejects(() => run(outputFlood), /output limit|invalid protocol/i);

  const timeout = await install('timeout-plugin', 'export async function run(){await new Promise(()=>{});return {ok:true}}', { limits: { timeoutMs: 300 } });
  await assert.rejects(() => run(timeout), /timed out/i);

  const cancelled = await install('cancel-plugin', 'export async function run(){await new Promise(()=>{});return {ok:true}}', { limits: { timeoutMs: 5000 } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => run(cancelled, {}, controller.signal), /cancelled/i);
});

test('sandbox enforces the declared V8 memory ceiling', async () => {
  const memory = await install('memory-ceiling', 'export async function run(){const held=[];for(;;)held.push({value:("x".repeat(2048)+Math.random())});}', { limits: { timeoutMs: 5000, memoryMb: 32, outputBytes: 32768 } });
  await assert.rejects(() => run(memory), /heap|memory|allocation|exited/i);
});

test('publisher packaging command creates a verifiable signed bundle without modifying its source', async () => {
  const source = path.join(folder, 'package-source');
  const output = path.join(folder, 'package-output');
  const keyFile = path.join(folder, 'publisher-private.pem');
  await mkdir(source);
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ ...manifest('packaged-plugin'), publisher: { id: 'package-publisher', name: 'Package Publisher' } }, null, 2));
  await writeFile(path.join(source, 'plugin.mjs'), 'export async function run(){return {ok:true}}');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'package-plugin.mjs'), source, keyFile, output], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
  const signed = JSON.parse(await readFile(path.join(output, 'plugin.json'), 'utf8'));
  assert.match(signed.package.digest, /^sha256:[a-f0-9]{64}$/);
  const installed = await installPluginPackage({ pluginRoot, manifest: signed, files: [{ path: 'plugin.mjs', content: await readFile(path.join(output, 'plugin.mjs'), 'utf8') }], trustedPublisherKey: signed.publisher.publicKey });
  assert.equal(installed.trust, 'signed-publisher');
  const sourceManifest = JSON.parse(await readFile(path.join(source, 'plugin.json'), 'utf8'));
  assert.equal(sourceManifest.package, undefined);
});
