import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PortraitAvatarService, portraitImageBytes, publicPortrait, portraitImageDigest } from '../lib/portrait-avatar.mjs';
const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(30)]);
const image = `data:image/png;base64,${bytes.toString('base64')}`;
test('image boundary rejects URLs, SVG, misleading MIME and overlarge input', () => {
  assert.deepEqual(portraitImageBytes(image), bytes);
  for (const input of ['https://example.com/photo.png', 'data:image/svg+xml;base64,abcd', image.replace('png','webp'), 'x'.repeat(1_600_001)]) assert.throws(() => portraitImageBytes(input));
});
test('only an exact owned atlas for the current image is exposed', () => {
  const agent = { id: 'one', avatarImage: image, portraitMediaId: 'portrait-one' };
  const media = [{ id: 'portrait-one', agentId: 'one', type: 'portrait-avatar', sourceDigest: portraitImageDigest(image), width: 640, height: 640, rows: 3, columns: 6 }];
  assert.ok(publicPortrait(agent, media));
  assert.equal(publicPortrait({ ...agent, id: 'two' }, media), null);
  assert.equal(publicPortrait({ ...agent, avatarImage: '' }, media), null);
});
test('revoked authority during preparation never installs or commits the generated atlas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexi-portrait-test-'));
  let allowed = true, committed = false;
  const mediaDir = path.join(root, 'media');
  const service = new PortraitAvatarService({ root, mediaDir, runner: async (_exe, args) => {
    const destination = args[args.indexOf('--destination') + 1];
    await fs.writeFile(destination, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]));
    allowed = false;
    return { stdout: JSON.stringify({ version: 1, columns: 6, rows: 3, width: 640, height: 640 }) };
  } });
  service.ready = async () => true;
  await service.start({ agentId: 'one', image, authorize: () => { if (!allowed) throw Object.assign(new Error('Revoked'), { status: 403 }); }, commit: () => { committed = true; } });
  while (service.running) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(committed, false); assert.equal(service.status('one').status, 'failed');
  assert.deepEqual(await fs.readdir(mediaDir).catch(() => []), []);
  assert.deepEqual(await fs.readdir(path.join(root, 'data/tools/liveportrait/work')), []);
  await fs.rm(root, { recursive: true, force: true });
});
