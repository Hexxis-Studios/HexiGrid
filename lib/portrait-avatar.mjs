import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const failure = (text, status = 400) => Object.assign(new Error(text), { status });
export function portraitImageBytes(value) {
  if (typeof value !== 'string' || value.length > 1_600_000) throw failure('Choose a portrait smaller than 1 MB.');
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw failure('Choose a PNG, JPEG or WebP portrait.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 1024 * 1024) throw failure('Choose a portrait smaller than 1 MB.');
  if (bytes.toString('base64') !== match[2] || bytes.length < 20) throw failure('The portrait image is invalid.');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw failure('The portrait image does not match its file type.');
  return bytes;
}
export const portraitImageDigest = image => createHash('sha256').update(image).digest('hex');
export function publicPortrait(agent, media = []) {
  const item = media.find(entry => entry.id === agent.portraitMediaId && entry.type === 'portrait-avatar' && entry.agentId === agent.id);
  return item && item.sourceDigest === portraitImageDigest(agent.avatarImage || '')
    ? { version: 1, url: `/api/media/${item.id}`, columns: item.columns, rows: item.rows, width: item.width, height: item.height, engine: 'LivePortrait' } : null;
}

/** A single bounded preparation process; calls never run this model per frame. */
export class PortraitAvatarService {
  constructor({ root, mediaDir, runner = execute } = {}) {
    this.root = root; this.mediaDir = mediaDir; this.runner = runner; this.jobs = new Map(); this.running = false;
    this.python = path.join(root, 'data/tools/liveportrait/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }
  async ready() { try { await fs.access(path.join(this.root, 'data/tools/liveportrait/ready.json')); await fs.access(this.python); return true; } catch { return false; } }
  status(agentId) { return this.jobs.get(agentId) || { status: 'idle' }; }
  async start({ agentId, image, commit, authorize, allowSetup = false }) {
    const bytes = portraitImageBytes(image);
    if (this.running) throw failure('Another portrait is being prepared. Try again shortly.', 409);
    const ready = await this.ready();
    if (this.running) throw failure('Another portrait is being prepared. Try again shortly.', 409);
    if (!ready && !allowSetup) throw failure('The owner needs to enable portrait animation once on this computer.', 409);
    authorize();
    this.running = true;
    const job = { id: randomUUID(), status: ready ? 'preparing' : 'setting-up', startedAt: new Date().toISOString() };
    this.jobs.set(agentId, job);
    void this.prepare({ job, bytes, image, commit, authorize, ready });
    return { ...job };
  }
  async prepare({ job, bytes, image, commit, authorize, ready }) {
    const temporary = path.join(this.root, 'data/tools/liveportrait/work', job.id);
    const mediaId = `portrait-${randomUUID()}`, filename = `${mediaId}.webp`;
    let installed = false;
    try {
      if (!ready) {
        await this.runner(process.execPath, [path.join(this.root, 'scripts/install-portrait-runtime.mjs')], { cwd: this.root, windowsHide: true, timeout: 1_200_000, maxBuffer: 100_000 });
        authorize(); job.status = 'preparing';
      }
      await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
      const source = path.join(temporary, 'source.img'), output = path.join(temporary, 'atlas.webp');
      await fs.writeFile(source, bytes, { mode: 0o600, flag: 'wx' });
      const { stdout } = await this.runner(this.python, [path.join(this.root, 'integrations/liveportrait/prepare_portrait.py'), '--root', this.root, '--source', source, '--destination', output], { windowsHide: true, timeout: 180_000, maxBuffer: 64_000 });
      const meta = JSON.parse(stdout.trim());
      if (meta.error || meta.version !== 1 || meta.columns !== 6 || meta.rows !== 3 || !Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 48 || meta.height < 48 || meta.width > 640 || meta.height > 640) throw failure('Portrait preparation returned an invalid result.');
      const atlas = await fs.readFile(output);
      if (atlas.length > 12 * 1024 * 1024 || atlas.toString('ascii', 0, 4) !== 'RIFF' || atlas.toString('ascii', 8, 12) !== 'WEBP') throw failure('Portrait preparation returned an invalid image.');
      authorize();
      await fs.mkdir(this.mediaDir, { recursive: true });
      await fs.writeFile(path.join(this.mediaDir, filename), atlas, { mode: 0o600, flag: 'wx' });
      installed = true;
      await commit({ ...meta, id: mediaId, type: 'portrait-avatar', filename, mimeType: 'image/webp', sourceDigest: portraitImageDigest(image), size: atlas.length, createdAt: new Date().toISOString() }, image);
      job.status = 'ready'; job.completedAt = new Date().toISOString();
    } catch (error) {
      if (installed) await fs.rm(path.join(this.mediaDir, filename), { force: true }).catch(() => {});
      job.status = 'failed';
      // No command lines, machine paths, images or upstream stderr in receipts.
      job.error = error.status ? error.message : 'The portrait could not be prepared. Your previous avatar is unchanged.';
    } finally {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      this.running = false;
    }
  }
}
