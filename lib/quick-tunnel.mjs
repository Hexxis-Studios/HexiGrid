import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export class QuickTunnel {
  constructor({ command = process.env.HEXIGRID_CLOUDFLARED || 'cloudflared', timeoutMs = 20000 } = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.url = '';
    this.error = '';
    this.startedAt = null;
  }

  status() {
    return { available: !this.error || Boolean(this.child), running: Boolean(this.child && this.url), starting: Boolean(this.child && !this.url), url: this.url, error: this.error, startedAt: this.startedAt };
  }

  async start(localUrl) {
    if (this.child) return this.status();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error('Quick Tunnel only accepts HexiGrid’s loopback address.');
    this.error = '';
    this.startedAt = new Date().toISOString();
    const child = spawn(this.command, ['tunnel', '--url', localUrl, '--no-autoupdate'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    this.child = child;
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { this.error = error.message; this.stop(); reject(error); }
        else resolve(this.status());
      };
      const inspect = (chunk) => {
        output = `${output}${chunk}`.slice(-16000);
        const match = output.match(URL_PATTERN);
        if (match) { this.url = match[0].toLowerCase(); finish(); }
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', () => finish(new Error('Cloudflare Tunnel is not installed. Install cloudflared, then try again.')));
      child.once('exit', (code) => {
        const wasStarting = !this.url;
        this.child = null;
        this.url = '';
        if (wasStarting) finish(new Error(`Cloudflare Tunnel stopped before it created a link${Number.isInteger(code) ? ` (exit ${code})` : ''}.`));
      });
      timer = setTimeout(() => finish(new Error('Cloudflare Tunnel did not create a link within 20 seconds.')), this.timeoutMs);
      timer.unref?.();
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.url = '';
    this.startedAt = null;
    if (child && !child.killed) child.kill();
    return this.status();
  }

  matchesRequest(req) {
    if (!this.child || !this.url) return false;
    let expectedHost = '';
    try { expectedHost = new URL(this.url).host; } catch { return false; }
    const actualHost = String(req.headers.host || '').toLowerCase();
    const connectingIp = String(req.headers['cf-connecting-ip'] || '');
    return actualHost === expectedHost && isIP(connectingIp) !== 0;
  }
}
