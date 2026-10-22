import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCodeCommand } from '../lib/opencode-command.mjs';
import { executeOpenCode, parseOpenCodeEvents } from '../lib/opencode-runtime.mjs';

test('Windows npm launchers resolve to the native OpenCode executable', () => {
  const native = 'C:\\Users\\QA\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
  for (const extension of ['cmd', 'ps1', 'bat']) {
    assert.deepEqual(openCodeCommand(`C:\\Users\\QA\\AppData\\Roaming\\npm\\opencode.${extension}`, {
      platform: 'win32', exists: (candidate) => candidate === native
    }), { command: native, args: [] });
  }
});

test('unresolvable shell launchers fail with native executable guidance', () => {
  assert.throws(() => openCodeCommand('C:\\QA\\custom.cmd', { platform: 'win32', exists: () => false }), /Set OPENCODE_CLI to opencode.exe/);
  assert.deepEqual(openCodeCommand('/usr/bin/opencode', { platform: 'linux' }), { command: '/usr/bin/opencode', args: [] });
  assert.deepEqual(openCodeCommand('C:\\Program Files\\OpenCode\\opencode.exe', { platform: 'win32' }), { command: 'C:\\Program Files\\OpenCode\\opencode.exe', args: [] });
});

test('runtime rejects shell execution before any process starts', async () => {
  for (const command of ['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'pwsh.exe', 'launch.cmd']) {
    await assert.rejects(executeOpenCode({ command, prompt: 'synthetic', workMode: 'plan', approvalPolicy: 'ask' }), /native executable/);
  }
});

test('actual native process receives the entire prompt as one literal argument', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-prompt-'));
  try {
    const fixture = path.join(directory, 'echo.mjs');
    await writeFile(fixture, `const p=process.argv.at(-1); console.log(JSON.stringify({type:'text',part:{text:p}}));`);
    const prompt = 'Synthetic identity\n\nCurrent task: 2 + 2?\nLiteral "quotes", & | < > %PATH% ^ and ExampleAgent 🌸';
    const reply = await executeOpenCode({ command: process.execPath, prefixArgs: [fixture], prompt, cwd: directory, model: 'synthetic/echo', workMode: 'plan', approvalPolicy: 'ask' });
    assert.equal(reply.content, prompt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('structured provider failures are actionable without exposing private diagnostics', () => {
  const raw = JSON.stringify({ type: 'error', error: { name: 'APIError', data: {
    message: "OpenCode's free tier can only be used from within OpenCode",
    responseHeaders: { authorization: 'private-fixture-token' }, metadata: { url: 'https://private.invalid' }
  } } });
  const reply = parseOpenCodeEvents(raw);
  assert.match(reply.errorMessage, /another available free or local/);
  assert.doesNotMatch(JSON.stringify(reply), /private-fixture-token|private.invalid/);
  assert.match(parseOpenCodeEvents(JSON.stringify({ type: 'error', error: { data: { message: 'private-fixture-token' } } })).errorMessage, /Check the selected AI connection/);
});
