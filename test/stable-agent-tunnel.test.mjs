import test from 'node:test';
import assert from 'node:assert/strict';
import { StableAgentTunnel, ConfiguredAgentTunnel, agentRelayStartupProvider } from '../lib/stable-agent-tunnel.mjs';

test('configured startup restores its route without changing saved temporary-provider preference', async () => {
  const preference = 'cloudflare-quick-tunnel';
  const tunnel = new ConfiguredAgentTunnel('https://relay.example.test');
  const status = await tunnel.start('http://127.0.0.1:4319', {
    provider: agentRelayStartupProvider('https://relay.example.test', preference)
  });
  assert.equal(status.running, true);
  assert.equal(status.url, 'https://relay.example.test');
  assert.equal(status.provider, 'configured-reverse-proxy');
  assert.equal(preference, 'cloudflare-quick-tunnel');
  assert.equal(agentRelayStartupProvider('', preference), preference);
  assert.equal(agentRelayStartupProvider('  ', preference), preference);
  await assert.rejects(() => tunnel.start('http://0.0.0.0:4318'), /loopback/);
  await assert.rejects(() => tunnel.start('http://127.0.0.1:4319', { provider: preference }), /configured stable route/);
  await tunnel.stop();
  assert.equal(tunnel.status().running, false);
});

test('stable agent tunnel preserves one fixed Tailscale hostname across restarts', async () => {
  const calls = []; let configured = false;
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'version') return '1.88.2';
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'owner.example.ts.net.' } });
    if (args[0] === 'funnel' && args[1] === 'status') return JSON.stringify(configured ? { Web: { 'owner.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4319' } } } } } : {});
    if (args[0] === 'funnel' && args.includes('--bg')) { configured = true; return ''; }
    if (args[0] === 'funnel' && args.at(-1) === 'off') { configured = false; return ''; }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const fallback = { start: async () => { throw new Error('fallback must not run'); }, stop: () => {}, status: () => ({}) };
  const primary = { start: async () => { throw new Error('dev tunnel unavailable in this test'); }, stop: async () => {}, status: () => ({}) };
  const tunnel = new StableAgentTunnel({ commandCandidates: ['tailscale'], runner, primary, fallback });
  const first = await tunnel.start('http://127.0.0.1:4319');
  assert.equal(first.url, 'https://owner.example.ts.net:8443'); assert.equal(first.stable, true);
  await tunnel.stop();
  const second = await tunnel.start('http://127.0.0.1:4319');
  assert.equal(second.url, first.url); assert.equal(calls.filter((args) => args.includes('--bg')).length, 2);
});

test('stable relay failure never creates a temporary address or changes the owner choice', async () => {
  let temporaryStarts = 0;
  const fallback = {
    async start() { temporaryStarts++; throw new Error('temporary route must not start'); },
    stop() {}, status() { return {}; }
  };
  const primary = { start: async () => { throw new Error('dev tunnel unavailable'); }, stop: async () => {}, status: () => ({}) };
  const tunnel = new StableAgentTunnel({ commandCandidates: ['missing'], runner: async () => { throw new Error('missing'); }, primary, fallback });
  await assert.rejects(tunnel.start('http://127.0.0.1:4319'), /No temporary address was created/);
  assert.equal(temporaryStarts, 0);
  const status = tunnel.status();
  assert.equal(status.running, false); assert.equal(status.starting, false);
  assert.equal(status.url, ''); assert.equal(status.provider, 'stable');
  assert.match(status.error, /Stable relays unavailable/);
});

test('existing exact stable route survives an engine shutdown without another provider or URL', async () => {
  const calls = [];
  let configured = true;
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'version') return '1.88.2';
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'owner.example.ts.net.' } });
    if (args[0] === 'funnel' && args[1] === 'status') return JSON.stringify(configured ? { Web: { 'owner.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4319' } } } } } : {});
    if (args.at(-1) === 'off') { configured = false; return ''; }
    throw new Error('Existing route must not be changed');
  };
  const primary = { start: async () => { throw new Error('Must not start another provider'); } };
  const fallback = { start: async () => { throw new Error('Must not create a temporary address'); } };
  const make = () => new StableAgentTunnel({ commandCandidates: ['tailscale'], runner, primary, fallback });
  const first = make();
  const initial = await first.start('http://127.0.0.1:4319');
  await first.stop({ preserveStableRoute: true });
  assert.equal(configured, true);
  const recovered = make();
  const after = await recovered.start('http://127.0.0.1:4319');
  assert.equal(after.url, initial.url);
  assert.equal(after.provider, 'tailscale-funnel');
  assert.equal(calls.some(args => args.includes('--bg') || args.at(-1) === 'off'), false);
  await recovered.stop();
  assert.equal(configured, false, 'explicit owner stop still revokes the public route');
});

test('owner can select Cloudflare directly and stop only that temporary tunnel', async () => {
  const calls = [];
  const fallback = {
    async start(localUrl) { calls.push(['cloudflare-start', localUrl]); return { available: true, running: true, starting: false, url: 'https://chosen.trycloudflare.com', error: '', startedAt: 'now' }; },
    async stop() { calls.push(['cloudflare-stop']); },
    status() { return {}; }
  };
  const primary = {
    async start() { calls.push(['stable-start']); throw new Error('Must not use stable provider when Cloudflare is selected.'); },
    async stop() { calls.push(['stable-stop']); }
  };
  const tunnel = new StableAgentTunnel({ commandCandidates: [], runner: async () => { calls.push(['tailscale']); throw new Error('Must not inspect Tailscale when Cloudflare is selected.'); }, primary, fallback });
  const started = await tunnel.start('http://127.0.0.1:4319', { provider: 'cloudflare-quick-tunnel' });
  assert.equal(started.running, true);
  assert.equal(started.stable, false);
  assert.equal(started.provider, 'cloudflare-quick-tunnel');
  assert.equal(started.url, 'https://chosen.trycloudflare.com');
  await tunnel.stop();
  assert.deepEqual(calls, [['cloudflare-start', 'http://127.0.0.1:4319'], ['cloudflare-stop']]);
});

test('unsupported agent relay provider is rejected before a tunnel starts', async () => {
  let started = false;
  const tunnel = new StableAgentTunnel({ commandCandidates: [], primary: {}, fallback: { start: async () => { started = true; } } });
  await assert.rejects(() => tunnel.start('http://127.0.0.1:4319', { provider: 'unknown' }), /supported agent relay provider/);
  assert.equal(started, false);
});
