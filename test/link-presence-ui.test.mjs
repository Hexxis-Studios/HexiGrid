import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = { window: {}, Intl, Date };
vm.runInNewContext(await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8'), context);
const presence = context.window.HexiGridViewRenderers.linkPresence;

test('UI distinguishes authorized idle and delayed heartbeats from current liveness', () => {
  assert.equal(presence({ authorizationStatus: 'connected', status: 'offline' }).label, 'Paired · heartbeat idle');
  assert.equal(presence({ authorizationStatus: 'connected', status: 'degraded' }).label, 'Heartbeat delayed');
  assert.equal(presence({ authorizationStatus: 'connected', status: 'online' }).label, 'Online');
  assert.equal(presence({}).label, 'Status unknown');
});

test('revocation overrides even a stale online heartbeat snapshot', () => {
  assert.equal(presence({ authorizationStatus: 'revoked', status: 'online', heartbeat: { state: 'online' } }).label, 'Revoked');
  assert.equal(presence({ authorizationStatus: 'stale', status: 'online' }).label, 'Replaced');
});

test('missing contact times are explicit and invalid times cannot become verified contact', () => {
  assert.equal(presence({ lastSeenAt: 'bad', lastHeartbeatAt: 'bad' }).detail, 'Last heartbeat: not received. Last signed contact: not received.');
  assert.match(presence({ lastSeenAt: '2026-09-30T07:17:19Z' }).detail, /Last heartbeat: not received\. Last signed contact: (?!not received)/);
});
