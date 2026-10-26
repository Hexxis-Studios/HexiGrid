import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexDesktopEnvironment } from '../lib/codex-desktop-bridge-discovery.mjs';

const valid = '\\\\.\\pipe\\codex-browser-use-12345678-1234-1234-1234-123456789abc';
const other = '\\\\.\\pipe\\codex-browser-use-87654321-1234-1234-1234-123456789abc';
const appTools = '\\\\.\\pipe\\codex-app-tools-12345678-1234-1234-1234-123456789abc';

test('current Codex app-tools transport is accepted and preferred over legacy browser pipes', async () => {
  const seen = [];
  const env = await resolveCodexDesktopEnvironment({ projectRoot: 'qa', sourceEnv: {},
    discover: async () => [other, appTools, valid], probe: async candidate => { seen.push(candidate.CODEX_APP_TOOLS_PIPE_PATH); return true; } });
  assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, appTools);
  assert.deepEqual(seen, [appTools]);
});

test('an inherited current app-tools pipe passes the same read-only probe without discovery', async () => {
  let scanned = false;
  const env = await resolveCodexDesktopEnvironment({ projectRoot: 'qa', sourceEnv: { CODEX_APP_TOOLS_PIPE_PATH: appTools },
    discover: async () => { scanned = true; return []; }, probe: async () => true });
  assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, appTools);
  assert.equal(scanned, false);
});

test('an independent HexiGrid process discovers and probes a current signed desktop pipe', async () => {
  const seen = [];
  const env = await resolveCodexDesktopEnvironment({ projectRoot: 'qa', sourceEnv: {},
    discover: async () => [other, '\\\\.\\pipe\\unrelated', valid],
    probe: async (candidate) => { seen.push(candidate.CODEX_APP_TOOLS_PIPE_PATH); return candidate.CODEX_APP_TOOLS_PIPE_PATH === valid; } });
  assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, valid);
  assert.deepEqual(seen, [other, valid]);
});

test('inherited desktop pipe is used without scanning when its read-only probe succeeds', async () => {
  let scanned = false;
  const env = await resolveCodexDesktopEnvironment({ projectRoot: 'qa', sourceEnv: { CODEX_APP_TOOLS_PIPE_PATH: valid },
    discover: async () => { scanned = true; return []; }, probe: async () => true });
  assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, valid);
  assert.equal(scanned, false);
});

test('desktop discovery fails closed when only unverified pipes exist', async () => {
  await assert.rejects(resolveCodexDesktopEnvironment({ projectRoot: 'qa', sourceEnv: {},
    discover: async () => ['\\\\.\\pipe\\arbitrary'], probe: async () => true }), /unavailable/);
});
