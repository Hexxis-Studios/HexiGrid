import { execFile as defaultExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { QuickTunnel } from './quick-tunnel.mjs';
import { DevTunnel } from './dev-tunnel.mjs';

const execFileAsync = promisify(defaultExecFile);

// An explicit operator-managed route owns startup transport selection. Keep the
// saved UI preference intact so removing the override restores that preference.
export function agentRelayStartupProvider(configuredOrigin, selectedProvider) {
  return String(configuredOrigin || '').trim() ? 'stable' : selectedProvider;
}

export class ConfiguredAgentTunnel {
  constructor(origin) {
    const parsed = new URL(String(origin || ''));
    const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) throw new Error('A configured agent relay origin must use HTTPS, except for an explicit loopback origin.');
    this.url = parsed.origin;
    this.cached = { available: true, running: false, starting: false, url: this.url, error: '', startedAt: null, stable: true, provider: 'configured-reverse-proxy' };
  }

  status() { return { ...this.cached }; }

  async start(localUrl, { provider = 'stable' } = {}) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error('The configured agent tunnel only accepts a HexiGrid loopback address.');
    if (provider !== 'stable') throw new Error('This HexiGrid install uses a configured relay endpoint; choose its configured stable route.');
    this.cached = { ...this.cached, running: true, startedAt: new Date().toISOString() };
    return this.status();
  }

  async stop() {
    this.cached = { ...this.cached, running: false, startedAt: null };
    return this.status();
  }
}

function candidates() {
  const explicit = process.env.HEXIGRID_TAILSCALE || '';
  if (process.platform !== 'win32') return [explicit, 'tailscale'].filter(Boolean);
  return [
    explicit,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe') : '',
    'tailscale.exe'
  ].filter(Boolean);
}

function dnsName(value) {
  const name = String(value || '').trim().replace(/\.$/, '').toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.ts\.net$/.test(name) ? name : '';
}

async function defaultRunner(command, args) {
  const result = await execFileAsync(command, args, { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  return String(result.stdout || '');
}

export class StableAgentTunnel {
  constructor({ httpsPort = 8443, commandCandidates = candidates(), runner = defaultRunner, primary = new DevTunnel(), fallback = new QuickTunnel() } = {}) {
    this.httpsPort = Math.max(1024, Math.min(65535, Number(httpsPort) || 8443));
    this.commandCandidates = commandCandidates;
    this.runner = runner;
    this.primary = primary;
    this.fallback = fallback;
    this.command = '';
    this.cached = { available: true, running: false, starting: false, url: '', error: '', startedAt: null, stable: false, provider: 'tailscale-funnel' };
  }

  status() { return { ...this.cached }; }

  async resolveCommand() {
    if (this.command) return this.command;
    for (const candidate of this.commandCandidates) {
      if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
      try { await this.runner(candidate, ['version']); this.command = candidate; return candidate; }
      catch { /* try the next installation */ }
    }
    return '';
  }

  async inspect(target = '') {
    const command = await this.resolveCommand();
    if (!command) return { available: false, running: false, url: '', error: 'Tailscale is not installed.', stable: false, provider: 'tailscale-funnel' };
    try {
      const node = JSON.parse(await this.runner(command, ['status', '--json']));
      const host = dnsName(node?.Self?.DNSName);
      const online = node?.BackendState === 'Running' && node?.Self?.Online !== false;
      const funnel = JSON.parse(await this.runner(command, ['funnel', 'status', '--json']) || '{}');
      const route = funnel?.Web?.[`${host}:${this.httpsPort}`]?.Handlers?.['/']?.Proxy || '';
      return {
        available: true, running: online && Boolean(host) && (!target || route === target),
        url: host ? `https://${host}:${this.httpsPort}` : '', dnsName: host, target: route,
        online, stable: true, provider: 'tailscale-funnel',
        error: !online ? 'Tailscale is installed but offline.' : !host ? 'Tailscale did not report a stable DNS name.' : target && route && route !== target ? `Tailscale Funnel port ${this.httpsPort} is already assigned to another local service.` : ''
      };
    } catch (error) {
      return { available: true, running: false, url: '', error: error.message || 'Tailscale Funnel status could not be read.', stable: false, provider: 'tailscale-funnel' };
    }
  }

  async start(localUrl, { provider = 'stable' } = {}) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error('The stable agent tunnel only accepts a HexiGrid loopback address.');
    if (!['stable', 'cloudflare-quick-tunnel'].includes(provider)) throw new Error('Choose a supported agent relay provider.');
    this.cached = { ...this.cached, starting: true, error: '', startedAt: new Date().toISOString() };
    if (provider === 'cloudflare-quick-tunnel') {
      this.cached = { ...this.cached, provider, stable: false };
      try {
        const fallback = await this.fallback.start(localUrl);
        this.cached = { ...fallback, starting: false, stable: false, provider, error: '' };
        return this.status();
      } catch (error) {
        this.cached = { ...this.cached, available: true, running: false, starting: false, url: '', provider, error: error.message || 'Cloudflare Quick Tunnel could not start.' };
        throw error;
      }
    }
    // Reuse an already published exact local route before starting a different
    // provider. Its existing hostname is already trusted by the companion.
    const existing = await this.inspect(localUrl);
    if (existing.running) {
      this.cached = { ...existing, starting: false, startedAt: this.cached.startedAt, stable: true };
      return this.status();
    }
    try {
      const primary = await this.primary.start(localUrl);
      this.cached = { ...primary, starting: false, startedAt: this.cached.startedAt, stable: true };
      return this.status();
    } catch (primaryError) {
      this.cached.error = primaryError.message;
    }
    const before = await this.inspect(localUrl);
    try {
      if (!before.available || !before.online || !before.url) throw new Error(before.error || 'Tailscale Funnel is unavailable.');
      if (!before.running) {
        if (before.target && before.target !== localUrl) throw new Error(before.error);
        await this.runner(await this.resolveCommand(), ['funnel', '--bg', '--yes', `--https=${this.httpsPort}`, localUrl]);
      }
      const after = await this.inspect(localUrl);
      if (!after.running) throw new Error(after.error || 'Tailscale Funnel did not publish the stable agent relay.');
      this.cached = { ...after, starting: false, startedAt: this.cached.startedAt, stable: true };
      return this.status();
    } catch (secondaryError) {
      const primaryMessage = String(this.cached.error || 'Microsoft Dev Tunnel is unavailable.').replace(/[.\s]+$/, '');
      const secondaryMessage = String(secondaryError.message || 'Tailscale Funnel is unavailable.').replace(/[.\s]+$/, '');
      // A temporary fallback changes the address trusted by the remote agent.
      // Keep the owner's stable choice; temporary exposure requires an explicit
      // provider selection rather than an automatic recovery side effect.
      const message = `Stable relays unavailable: ${primaryMessage}; ${secondaryMessage}. No temporary address was created. Retry the stable route or explicitly choose a temporary Quick Tunnel.`;
      this.cached = { ...this.cached, running: false, starting: false, url: '', stable: false, provider: 'stable', error: message };
      throw new Error(message);
    }
  }

  async stop({ preserveStableRoute = false } = {}) {
    if (this.cached.provider === 'microsoft-dev-tunnel') await this.primary.stop();
    else if (this.cached.provider === 'cloudflare-quick-tunnel') await this.fallback.stop();
    else if (this.command && this.cached.running && !preserveStableRoute) await this.runner(this.command, ['funnel', `--https=${this.httpsPort}`, 'off']).catch(() => {});
    this.cached = { available: true, running: false, starting: false, url: '', error: '', startedAt: null, stable: false, provider: 'tailscale-funnel' };
    return this.status();
  }
}
