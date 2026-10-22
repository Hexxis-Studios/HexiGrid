import test from 'node:test';
import assert from 'node:assert/strict';
import { QuickTunnel } from '../lib/quick-tunnel.mjs';

test('quick tunnel recognizes only its active Cloudflare hostname and connecting IP', () => {
  const tunnel = new QuickTunnel();
  tunnel.child = { killed: false, kill() { this.killed = true; } };
  tunnel.url = 'https://one-two.trycloudflare.com';
  assert.equal(tunnel.matchesRequest({ headers: { host: 'one-two.trycloudflare.com', 'cf-connecting-ip': '203.0.113.7' } }), true);
  assert.equal(tunnel.matchesRequest({ headers: { host: 'ONE-TWO.TRYCLOUDFLARE.COM', 'cf-connecting-ip': '2001:db8::1' } }), true);
  assert.equal(tunnel.matchesRequest({ headers: { host: 'one-two.trycloudflare.com', 'cf-connecting-ip': '999.999.999.999' } }), false);
  assert.equal(tunnel.matchesRequest({ headers: { host: 'one-two.trycloudflare.com', 'cf-connecting-ip': 'abc:feed' } }), false);
  assert.equal(tunnel.matchesRequest({ headers: { host: 'one-two.trycloudflare.com' } }), false);
  assert.equal(tunnel.matchesRequest({ headers: { host: 'attacker.example', 'cf-connecting-ip': '203.0.113.7' } }), false);
  tunnel.stop();
  assert.equal(tunnel.matchesRequest({ headers: { host: 'one-two.trycloudflare.com', 'cf-connecting-ip': '203.0.113.7' } }), false);
});

test('quick tunnel refuses to expose a non-loopback destination', async () => {
  const tunnel = new QuickTunnel();
  await assert.rejects(() => tunnel.start('http://0.0.0.0:4318'), /loopback/);
});

test('missing cloudflared fails clearly without leaving a tunnel process marked active', async () => {
  const tunnel = new QuickTunnel({ command: `missing-cloudflared-${Date.now()}`, timeoutMs: 1000 });
  await assert.rejects(() => tunnel.start('http://127.0.0.1:4318'), /not installed/);
  assert.equal(tunnel.status().running, false);
  assert.equal(tunnel.status().starting, false);
  assert.match(tunnel.status().error, /not installed/);
});
