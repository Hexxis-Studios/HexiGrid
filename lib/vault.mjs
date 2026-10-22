import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeProtectedCredential } from './vault-storage.mjs';
import { removePlatformCredentials } from './vault-removal.mjs';

function unavailableError(detail = '') {
  const error = new Error(detail || 'The operating system credential vault is unavailable. Install and unlock the platform credential service before adding API keys, OAuth credentials, or connector secrets.');
  error.code = 'VAULT_UNAVAILABLE';
  error.status = 503;
  return error;
}

function runCommand(command, args, input = '', timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errorText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Credential vault operation timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(unavailableError()); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(output.trim());
      const error = unavailableError(errorText.trim());
      error.exitCode = code; error.stderr = errorText.trim();
      reject(error);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Secrets travel over stdin where the platform tool supports it, never arguments.
function protectWindows(value, decrypt = false) {
  const operation = decrypt
    ? '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  const script = '$ErrorActionPreference=\'Stop\'; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); [Console]::Out.Write(' + operation + ')';
  return runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], value);
}

async function platformSet(id, secret) {
  if (process.platform === 'win32') return protectWindows(secret);
  if (process.platform === 'linux') return runCommand('secret-tool', ['store', '--label', 'HexiGrid protected credential', 'service', 'HexiGrid', 'id', id], secret + '\n');
  if (process.platform === 'darwin') return runCommand('security', ['add-generic-password', '-a', process.env.USER || 'HexiGrid', '-s', 'HexiGrid:' + id, '-U', '-w'], secret + '\n');
  throw new Error('This operating system does not expose a supported credential vault.');
}

async function platformGetForBrand(id, brand) {
  if (process.platform === 'win32') return protectWindows(id, true);
  if (process.platform === 'linux') return runCommand('secret-tool', ['lookup', 'service', brand, 'id', id]);
  if (process.platform === 'darwin') return runCommand('security', ['find-generic-password', '-a', process.env.USER || brand, '-s', brand + ':' + id, '-w']);
  throw new Error('This operating system does not expose a supported credential vault.');
}

async function platformGet(id) {
  try { return await platformGetForBrand(id, 'HexiGrid'); }
  catch (currentError) {
    try { return await platformGetForBrand(id, 'Aveniq'); }
    catch { throw currentError; }
  }
}

async function platformRemove(id, strict) {
  if (process.platform === 'win32') return;
  return removePlatformCredentials(id, { platform: process.platform, account: process.env.USER, run: runCommand, strict });
}

export class CredentialVault {
  constructor(directory) { const disabled = process.env.HEXIGRID_DISABLE_OS_VAULT === '1' || process.env.AVENIQ_DISABLE_OS_VAULT === '1'; this.directory = directory; this.available = !disabled; this.forcedUnavailable = disabled; }
  isAvailable() { return this.available && !this.forcedUnavailable; }
  file(id) { if (!/^[a-zA-Z0-9-]{1,90}$/.test(id)) throw new Error('Invalid credential reference.'); return path.join(this.directory, id + '.protected'); }
  async set(id, secret) {
    if (typeof secret !== 'string' || !secret || secret.length > 16000) throw new Error('Invalid API key.');
    if (!this.isAvailable()) throw unavailableError();
    try {
      if (process.platform === 'win32') { const encrypted = await platformSet(id, secret); await fs.mkdir(this.directory, { recursive: true }); await writeProtectedCredential(this.file(id), encrypted); return; }
      await platformSet(id, secret);
    } catch (error) { if (error?.code === 'VAULT_UNAVAILABLE') this.available = false; throw error; }
  }
  async get(id) {
    if (!this.isAvailable()) return '';
    try {
      if (process.platform === 'win32') { try { return await platformGet(await fs.readFile(this.file(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }
      return await platformGet(id);
    } catch (error) {
      if (/not found|could not find|No such file/i.test(error.message)) return '';
      if (error?.code === 'VAULT_UNAVAILABLE') { this.available = false; return ''; }
      throw error;
    }
  }
  async remove(id, { requireAvailable = false } = {}) {
    if (!this.isAvailable()) { if (requireAvailable) throw unavailableError(); return; }
    if (process.platform === 'win32') return fs.rm(this.file(id), { force: true });
    try { return await platformRemove(id, requireAvailable); } catch (error) { if (error?.code === 'VAULT_UNAVAILABLE') this.available = false; if (requireAvailable) throw error; }
  }
}
