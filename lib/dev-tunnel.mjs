import { execFile as defaultExecFile, spawn as defaultSpawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(defaultExecFile);

function commandCandidates() {
  const explicit = process.env.HEXIGRID_DEVTUNNEL || '';
  if (process.platform !== 'win32') return [explicit, 'devtunnel'].filter(Boolean);
  return [
    explicit,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'devtunnel.exe') : '',
    'devtunnel.exe'
  ].filter(Boolean);
}

async function defaultRunner(command, args) {
  const result = await execFileAsync(command, args, { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return String(result.stdout || '');
}

function parseJson(value) {
  const source = String(value || ''); const start = source.indexOf('{'); const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Dev Tunnel returned an unreadable response.');
  return JSON.parse(source.slice(start, end + 1));
}

function publicPort(tunnel, port) {
  return (tunnel?.ports || []).find((item) => Number(item.portNumber) === Number(port));
}

export class DevTunnel {
  constructor({ tunnelId = process.env.HEXIGRID_DEV_TUNNEL_ID || 'hexigrid-agent-relay', port = 4319, candidates = commandCandidates(), runner = defaultRunner, spawn = defaultSpawn, pidFile = path.join(os.homedir(), '.hexigrid', 'devtunnel-relay.pid'), monitorMs = 15_000 } = {}) {
    this.tunnelId = String(tunnelId || '').trim();
    this.port = Math.max(1024, Math.min(65535, Number(port) || 4319));
    this.candidates = candidates; this.runner = runner; this.spawn = spawn; this.pidFile = pidFile;
    this.monitorMs = Math.max(5_000, Math.min(120_000, Number(monitorMs) || 15_000));
    this.command = ''; this.process = null; this.monitor = null; this.starting = null;
    this.cached = { available: true, running: false, starting: false, url: '', error: '', startedAt: null, stable: true, provider: 'microsoft-dev-tunnel' };
  }

  status() { return { ...this.cached }; }

  async resolveCommand() {
    if (this.command) return this.command;
    for (const candidate of this.candidates) {
      if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
      try { await this.runner(candidate, ['--version']); this.command = candidate; return candidate; } catch { /* keep looking */ }
    }
    return '';
  }

  async show() {
    const command = await this.resolveCommand();
    if (!command) throw new Error('Microsoft Dev Tunnels is not installed.');
    return parseJson(await this.runner(command, ['show', this.tunnelId, '--json'])).tunnel;
  }

  async ensureSetup() {
    const command = await this.resolveCommand();
    if (!command) throw new Error('Microsoft Dev Tunnels is not installed.');
    const user = await this.runner(command, ['user', 'show']).catch(() => 'Not logged in.');
    if (/not logged in/i.test(user)) {
      if (process.platform !== 'win32') throw new Error('Dev Tunnel needs a one-time account sign-in.');
      await this.runner(command, ['user', 'login', '--entra', '--use-integrated-windows-auth']);
    }
    let tunnel;
    try { tunnel = await this.show(); }
    catch {
      await this.runner(command, ['create', this.tunnelId, '--allow-anonymous', '--description', 'HexiGrid encrypted companion relay', '--json']);
      tunnel = await this.show();
    }
    await this.runner(command, ['update', this.tunnelId, '--expiration', '30d', '--json']).catch(() => {});
    if (!publicPort(tunnel, this.port)) {
      await this.runner(command, ['port', 'create', this.tunnelId, '--port-number', String(this.port), '--protocol', 'http', '--description', 'Encrypted companion relay', '--json']);
    }
  }

  async writePid(pid) {
    await fs.mkdir(path.dirname(this.pidFile), { recursive: true });
    await fs.writeFile(this.pidFile, String(pid), { mode: 0o600 });
  }

  async spawnHost() {
    const command = await this.resolveCommand();
    const child = this.spawn(command, ['host', this.tunnelId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child; await this.writePid(child.pid);
    child.once('exit', () => { if (this.process === child) this.process = null; });
    child.stdout?.resume(); child.stderr?.resume();
  }

  async inspect() {
    const tunnel = await this.show(); const port = publicPort(tunnel, this.port);
    return {
      available: true,
      running: Number(tunnel.hostConnections || 0) > 0 && Boolean(port?.portUri),
      starting: false,
      url: String(port?.portUri || '').replace(/\/$/, ''),
      stable: true,
      provider: 'microsoft-dev-tunnel',
      error: port?.portUri ? '' : `Dev Tunnel port ${this.port} is not configured.`
    };
  }

  async ensureOnline() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let status = await this.inspect();
      if (!status.running) {
        await this.spawnHost();
        const deadline = Date.now() + 15_000;
        do { await new Promise((resolve) => setTimeout(resolve, 500)); status = await this.inspect(); } while (!status.running && Date.now() < deadline);
      }
      if (!status.running) throw new Error('Dev Tunnel did not establish its public HTTPS connection.');
      this.cached = { ...status, startedAt: this.cached.startedAt || new Date().toISOString() };
      return this.status();
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async start(localUrl) {
    if (localUrl !== `http://127.0.0.1:${this.port}`) throw new Error('Dev Tunnel accepts only its assigned HexiGrid loopback relay.');
    this.cached = { ...this.cached, starting: true, error: '', startedAt: new Date().toISOString() };
    await this.ensureSetup(); await this.ensureOnline();
    if (!this.monitor) {
      this.monitor = setInterval(() => this.ensureOnline().catch((error) => { this.cached = { ...this.cached, running: false, starting: false, error: error.message }; }), this.monitorMs);
      this.monitor.unref?.();
    }
    return this.status();
  }

  async stop() {
    if (this.monitor) clearInterval(this.monitor); this.monitor = null;
    const child = this.process;
    let recordedPid = '';
    try { recordedPid = (await fs.readFile(this.pidFile, 'utf8')).trim(); } catch { /* no recorded process */ }
    // A PID saved before a restart can now belong to any application. Only the
    // ChildProcess handle created by this instance establishes stop authority.
    if (!child && recordedPid) {
      this.cached = { ...this.cached, starting: false, error: 'This instance does not own the recorded Dev Tunnel process. No process was stopped; verify its ownership before stopping it manually.' };
      return this.status();
    }
    if (child && !child.killed && child.exitCode == null) {
      try {
        if (!child.kill()) throw new Error('Signal refused');
      } catch {
        this.cached = { ...this.cached, starting: false, error: 'The owned Dev Tunnel process could not be stopped. No other process was signalled.' };
        return this.status();
      }
    }
    if (this.process === child) this.process = null;
    if (child && recordedPid === String(child.pid)) await fs.rm(this.pidFile, { force: true }).catch(() => {});
    this.cached = { available: true, running: false, starting: false, url: '', error: '', startedAt: null, stable: true, provider: 'microsoft-dev-tunnel' };
    return this.status();
  }
}
