import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DevTunnel } from '../lib/dev-tunnel.mjs';

test('persistent Dev Tunnel keeps one ordinary HTTPS origin and renews its expiry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-devtunnel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = []; let hostConnections = 0;
  const tunnelRecord = () => ({ tunnel: { tunnelId: 'hexigrid-test.usw3', hostConnections, ports: [{ portNumber: 4319, protocol: 'http', portUri: 'https://stable-4319.usw3.devtunnels.ms/' }] } });
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === '--version') return '1.0';
    if (args[0] === 'user') return 'Logged in.';
    if (args[0] === 'show') return JSON.stringify(tunnelRecord());
    if (args[0] === 'update') return JSON.stringify(tunnelRecord());
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const spawn = () => {
    const child = new EventEmitter(); child.pid = 43210; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setTimeout(() => { hostConnections = 1; }, 5); return child;
  };
  const tunnel = new DevTunnel({ candidates: ['devtunnel'], runner, spawn, pidFile: path.join(root, 'relay.pid'), monitorMs: 60_000 });
  t.after(() => { if (tunnel.monitor) clearInterval(tunnel.monitor); });
  const status = await tunnel.start('http://127.0.0.1:4319');
  assert.equal(status.url, 'https://stable-4319.usw3.devtunnels.ms');
  assert.equal(status.running, true); assert.equal(status.stable, true); assert.equal(status.provider, 'microsoft-dev-tunnel');
  assert.equal(calls.some((args) => args[0] === 'update' && args.includes('30d')), true);
  assert.equal(await fs.readFile(path.join(root, 'relay.pid'), 'utf8'), '43210');
});

test('stop refuses a persisted PID without its live owned child handle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-devtunnel-stop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'relay.pid');
  await fs.writeFile(pidFile, String(process.pid));
  const signals = [];
  t.mock.method(process, 'kill', pid => { signals.push(pid); return true; });
  const tunnel = new DevTunnel({ pidFile });
  tunnel.cached.running = true;
  const result = await tunnel.stop();
  assert.deepEqual(signals, []);
  assert.equal(result.running, true, 'do not falsely report the unowned tunnel stopped');
  assert.match(result.error, /not.*own|unverified|ownership/i);
  assert.equal(await fs.readFile(pidFile, 'utf8'), String(process.pid));
});

test('stop only signals the captured owned child and clears its PID record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-devtunnel-owned-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'relay.pid');
  await fs.writeFile(pidFile, '43210');
  const signals = [];
  t.mock.method(process, 'kill', pid => { signals.push(pid); return true; });
  const tunnel = new DevTunnel({ pidFile });
  let ownedSignals = 0;
  tunnel.process = { pid: 43210, killed: false, kill() { ownedSignals++; return true; } };
  const result = await tunnel.stop();
  assert.equal(ownedSignals, 1);
  assert.deepEqual(signals, []);
  assert.equal(result.running, false);
  await assert.rejects(fs.readFile(pidFile), { code: 'ENOENT' });
});

test('failed owned stop retains its handle, running standing and PID', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-devtunnel-failed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'relay.pid');
  await fs.writeFile(pidFile, '43210');
  const tunnel = new DevTunnel({ pidFile });
  const child = { pid: 43210, exitCode: null, killed: false, kill() { return false; } };
  tunnel.process = child; tunnel.cached.running = true;
  const result = await tunnel.stop();
  assert.equal(tunnel.process, child);
  assert.equal(result.running, true);
  assert.match(result.error, /could not be stopped/);
  assert.equal(await fs.readFile(pidFile, 'utf8'), '43210');
});

test('an exited owned child is never signalled and a different PID record is retained', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-devtunnel-exited-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'relay.pid');
  await fs.writeFile(pidFile, '43211');
  const tunnel = new DevTunnel({ pidFile });
  tunnel.process = { pid: 43210, exitCode: 0, killed: false, kill() { assert.fail('exited child must not be signalled'); } };
  await tunnel.stop();
  assert.equal(await fs.readFile(pidFile, 'utf8'), '43211');
});
