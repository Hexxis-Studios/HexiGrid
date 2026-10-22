import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { actDesktopUia, clearDesktopUiaTargets, inspectDesktopUia } from '../lib/desktop-bridge.mjs';

function uiaSpawn(responses, captured = []) {
  let index = 0;
  return (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.equal(args.at(-2), '-InputPath');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    import('node:fs/promises').then(async ({ readFile }) => {
      captured.push(JSON.parse(await readFile(args.at(-1), 'utf8')));
      child.stdout.emit('data', Buffer.from(JSON.stringify(responses[index++])));
      child.emit('close', 0);
    }).catch((error) => child.emit('error', error));
    return child;
  };
}

const missing = 'The inspected control is missing or ambiguous. Inspect the active window again.';
const checkbox = { runtimeId: [1, 2, 3], name: 'Remember me', automationId: 'remember', controlType: 'CheckBox', bounds: { x: 1, y: 2, width: 20, height: 20 }, enabled: true, supports: { toggle: true } };

test.beforeEach(() => clearDesktopUiaTargets());

for (const scenario of ['disappeared control', 'supported child behind omitted Pane']) {
  test(`UIA discovery/action mismatch (${scenario}) preserves bounded fallback without action retry`, async () => {
    const requests = [];
    const targets = await inspectDesktopUia({ linkId: `g8b-${scenario}`, bridgeStartedAt: 'session-g8b', platform: 'win32', spawnFn: uiaSpawn([
      { ok: true, operation: 'inspect', windowHandle: 44, controls: [checkbox], truncated: false },
      { ok: false, fallback: 'screenshot-coordinate', reason: missing }
    ], requests) });
    assert.equal(targets.controls.length, 1);
    const result = await actDesktopUia({ kind: 'toggle', targetKey: targets.controls[0].targetKey, expected: true }, {
      linkId: `g8b-${scenario}`, bridgeStartedAt: 'session-g8b', platform: 'win32', spawnFn: uiaSpawn([
        { ok: false, fallback: 'screenshot-coordinate', reason: missing }
      ], requests)
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, missing);
    assert.equal(result.fallback, 'screenshot-coordinate');
    assert.deepEqual(requests, [
      { operation: 'inspect' },
      { operation: 'toggle', windowHandle: 44, runtimeId: [1, 2, 3], fingerprint: { name: 'Remember me', automationId: 'remember', controlType: 'CheckBox', bounds: checkbox.bounds }, expected: true }
    ]);
  });
}
