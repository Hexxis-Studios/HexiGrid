import { execFile as defaultExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(defaultExecFile);

function defaultCandidates() {
  const explicit = process.env.HEXIGRID_TAILSCALE || '';
  if (process.platform !== 'win32') return [explicit, 'tailscale'].filter(Boolean);
  return [
    explicit,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe') : '',
    'tailscale.exe'
  ].filter(Boolean);
}

function collectProxyTargets(value, targets = []) {
  if (!value || typeof value !== 'object') return targets;
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === 'proxy' && typeof item === 'string') targets.push(item);
    else if (item && typeof item === 'object') collectProxyTargets(item, targets);
  }
  return targets;
}

function validDnsName(value) {
  const name = String(value || '').trim().replace(/\.$/, '').toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(name) && name.endsWith('.ts.net') ? name : '';
}

async function defaultRunner(command, args) {
  const result = await execFileAsync(command, args, { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  return String(result.stdout || '');
}

export class TailnetLink {
  constructor({ port, candidates = defaultCandidates(), runner = defaultRunner } = {}) {
    this.port = Number(port);
    this.target = `http://127.0.0.1:${this.port}`;
    this.candidates = candidates;
    this.runner = runner;
    this.command = '';
  }

  async resolveCommand() {
    if (this.command) return this.command;
    for (const candidate of this.candidates) {
      if ((path.isAbsolute(candidate) && !existsSync(candidate))) continue;
      try {
        await this.runner(candidate, ['version']);
        this.command = candidate;
        return candidate;
      } catch { /* try the next supported installation path */ }
    }
    return '';
  }

  async inspect() {
    const command = await this.resolveCommand();
    if (!command) return { available: false, running: false, url: '', dnsName: '', online: false, conflict: false, error: 'Tailscale is not installed.' };
    try {
      const status = JSON.parse(await this.runner(command, ['status', '--json']));
      const dnsName = validDnsName(status?.Self?.DNSName);
      const online = status?.BackendState === 'Running' && status?.Self?.Online !== false;
      let serve = {};
      try { serve = JSON.parse(await this.runner(command, ['serve', 'status', '--json']) || '{}'); }
      catch { serve = {}; }
      const proxyTargets = collectProxyTargets(serve);
      const running = proxyTargets.includes(this.target);
      const configured = Object.keys(serve || {}).length > 0;
      const conflict = configured && (!running || proxyTargets.length !== 1);
      return {
        available: true,
        running: running && online && Boolean(dnsName),
        url: dnsName ? `https://${dnsName}` : '',
        dnsName,
        online,
        conflict,
        target: this.target,
        error: !online ? 'Tailscale is installed but not connected.' : !dnsName ? 'Tailscale did not report a private DNS name.' : conflict ? 'Tailscale Serve already has a different configuration. HexiGrid did not change it.' : ''
      };
    } catch (error) {
      return { available: true, running: false, url: '', dnsName: '', online: false, conflict: false, target: this.target, error: error.message || 'Tailscale status could not be read.' };
    }
  }

  async start() {
    const before = await this.inspect();
    if (!before.available || !before.online || !before.url) throw new Error(before.error || 'Tailscale is not ready.');
    if (before.running) return before;
    if (before.conflict) throw new Error(before.error);
    const command = await this.resolveCommand();
    await this.runner(command, ['serve', '--bg', '--yes', this.target]);
    const after = await this.inspect();
    if (!after.running) throw new Error(after.error || 'Tailscale Serve did not expose HexiGrid.');
    return after;
  }

  async stop() {
    const before = await this.inspect();
    if (!before.running) return before;
    if (before.conflict) throw new Error('Tailscale Serve changed after HexiGrid opened it. HexiGrid did not remove any routes.');
    const command = await this.resolveCommand();
    await this.runner(command, ['serve', 'reset']);
    const after = await this.inspect();
    if (after.running) throw new Error('Tailscale Serve is still routing to HexiGrid.');
    return after;
  }
}

export function isPrivateTailnetHost(host = '') {
  const hostname = String(host).trim().toLowerCase().replace(/^\[/, '').replace(/\](:\d+)?$/, '').split(':')[0].replace(/\.$/, '');
  return hostname.endsWith('.ts.net');
}
