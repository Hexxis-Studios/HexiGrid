// Download only the MIT LivePortrait human models, never InsightFace weights.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'integrations/liveportrait/source-manifest.json'), 'utf8'));
for (const [name, digest] of Object.entries(manifest.weights)) {
  const target = path.join(root, 'data/tools/liveportrait/upstream/pretrained_weights', name);
  try { if (createHash('sha256').update(await fs.readFile(target)).digest('hex') === digest) continue; } catch {}
  await fs.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(`https://huggingface.co/${manifest.modelRepository}/resolve/${manifest.modelRevision}/${name}`);
  if (!response.ok) throw new Error(`Portrait model download failed: ${response.status}`);
  const temporary = `${target}.download`;
  const handle = await fs.open(temporary, 'w', 0o600); const hash = createHash('sha256');
  try {
    for await (const bytes of response.body) { hash.update(bytes); await handle.write(bytes); }
    await handle.close();
    if (hash.digest('hex') !== digest) throw new Error('Portrait model checksum did not match.');
    await fs.rename(temporary, target);
    console.log(`Prepared ${path.basename(name)}`);
  } catch (error) { await handle.close().catch(() => {}); await fs.rm(temporary, { force: true }); throw error; }
}
