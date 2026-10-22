#!/usr/bin/env node
// Host-only bridge between this Codex task and HexiGrid's encrypted Link inbox.
import path from 'node:path';
import { CredentialVault } from '../lib/vault.mjs';

const command = process.argv[2];
const dataDir = path.resolve(process.env.HEXIGRID_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const vault = new CredentialVault(path.join(dataDir, 'vault'));
const credential = await vault.get('codex-door-local-secret');
if (!credential) throw new Error('The local Codex Door credential is unavailable in the OS vault.');
if (!['status', 'claim', 'reply', 'release'].includes(command)) throw new Error('Use status, claim, reply, or release.');

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? '' : String(process.argv[at + 1] || '');
}

async function stdinText() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 50000) throw new Error('The reply exceeds 50,000 characters.');
  }
  return value.trim();
}

const body = command === 'reply'
  ? { id: option('--id'), claimId: option('--claim'), text: await stdinText() }
  : command === 'release'
    ? { id: option('--id'), claimId: option('--claim') }
    : {};
if (['reply', 'release'].includes(command) && (!body.id || !body.claimId)) throw new Error('A message ID and claim ID are required.');
if (command === 'reply' && !body.text) throw new Error('A non-empty reply is required on stdin.');

const port = Number(process.env.HEXIGRID_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The local HexiGrid port is invalid.');
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 12000);
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/codex-door/v1/${command}`, {
    method: command === 'status' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: command === 'status' ? undefined : JSON.stringify(body),
    signal: controller.signal
  });
  const result = await response.json();
  if (!response.ok) throw new Error(String(result.error || 'The local Codex Door request failed.'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { clearTimeout(deadline); }
