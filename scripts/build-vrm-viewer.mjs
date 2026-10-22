import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, 'public', 'vendor');
await mkdir(vendor, { recursive: true });
await build({
  entryPoints: [path.join(root, 'client/avatar-vrm-viewer.js')],
  outfile: path.join(vendor, 'vrm-viewer.js'),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  legalComments: 'none'
});
await writeFile(path.join(vendor, 'vrm-viewer.css'), `:host{display:block;position:relative;min-width:0;min-height:0;overflow:hidden;touch-action:none}canvas{display:block;width:100%;height:100%;outline:none}.error{position:absolute;inset:auto 8px 8px;margin:0;padding:7px 9px;border:1px solid #77576e;border-radius:8px;background:#211822eF;color:#ffd9df;font:12px/1.4 system-ui,sans-serif;overflow-wrap:anywhere}`);
const licenseDirectory = path.join(vendor, 'licenses');
await mkdir(licenseDirectory, { recursive: true });
for (const packageName of [
  '@pixiv/three-vrm', '@pixiv/three-vrm-core', '@pixiv/three-vrm-materials-hdr-emissive-multiplier',
  '@pixiv/three-vrm-materials-mtoon', '@pixiv/three-vrm-materials-v0compat',
  '@pixiv/three-vrm-node-constraint', '@pixiv/three-vrm-springbone'
]) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
  const basename = packageName.replace('@pixiv/', 'pixiv-');
  await copyFile(path.join(root, 'node_modules', packageName, 'LICENSE'), path.join(licenseDirectory, `${basename}-${packageJson.version}-MIT.txt`));
}
