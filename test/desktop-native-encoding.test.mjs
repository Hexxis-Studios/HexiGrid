import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Encoding transport did not exit within ten seconds.')); }, 10000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout }) : reject(new Error(`Encoding transport exited ${code}: ${stderr}`)); });
  });
}
test('native desktop JSON transport preserves Unicode without exercising desktop APIs', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-encoding-'));
  try {
    const value = 'Café 日本語 العربية 🌿 "quoted" \\ path';
    const inputPath = path.join(directory, 'request.json');
    await fs.writeFile(inputPath, JSON.stringify({ value }), 'utf8');
    for (const name of ['desktop-uia.ps1', 'desktop-input.ps1']) {
      const source = await fs.readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
      // Execute only the actual transport lines, never UIA, SendInput or a desktop action.
      const encoding = source.split(/\r?\n/).find(line => line.startsWith('[Console]::OutputEncoding ='));
      const read = source.split(/\r?\n/).find(line => /^\$(request|input) = Get-Content/.test(line));
      assert.ok(encoding); assert.ok(read);
      const variable = name === 'desktop-uia.ps1' ? '$request' : '$input';
      const script = path.join(directory, 'transport.ps1');
      await fs.writeFile(script, `param([string]$InputPath)\n$ErrorActionPreference = 'Stop'\n${encoding}\n${read}\n[Console]::Out.WriteLine((${variable} | ConvertTo-Json -Compress))\nexit 0\n`, 'utf8');
      const { stdout } = await run(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-InputPath', inputPath]);
      assert.equal(JSON.parse(stdout).value, value, name);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

