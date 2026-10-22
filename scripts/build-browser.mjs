import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'releases', `browser-${pkg.version}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const stage = path.join(output, 'web');
await fs.mkdir(stage, { recursive: true });
const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--', 'public'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const files = stdout.split('\0').filter(Boolean);
if (!files.includes('public/index.html') || !files.includes('public/sw.js')) throw new Error('The browser source is incomplete.');
for (const file of files) {
  const source = path.join(root, file), target = path.join(stage, file.slice('public/'.length));
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular browser assets can be packaged.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
for (const file of ['LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'SECURITY.md']) await fs.copyFile(path.join(root, file), path.join(stage, file));
await fs.writeFile(path.join(stage, 'README.md'), `# HexiGrid browser app\n\nServe the contents of this folder at the root of your own HTTPS website, then open that address in a modern browser. A localhost web server also works on the same device. Do not open index.html directly from the file manager.\n\nCreate a local browser passcode and connect your own model or agent. Use the browser's Install app or Add to Home Screen option for an app shortcut, where supported. The in-app Help contains setup guides and screenshots.\n\nStandalone browser data stays in its encrypted browser vault. Back it up before clearing site data; a forgotten browser passcode cannot be recovered.\n\nDesktop programs, computer control and reliable background tasks require a paired Windows host. Some cloud providers do not allow direct browser requests; use their supported connection or a trusted host.\n\nSource, Windows downloads and support: https://github.com/Hexxis-Studios/HexiGrid\n`);
const archive = path.join(output, `HexiGrid-Browser-${pkg.version}.zip`);
if (process.platform !== 'win32') throw new Error('Run this archive builder on Windows. The resulting web files can be hosted on any platform.');
await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '& { param($source,$destination) Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($source,$destination) }', stage, archive],
{ windowsHide: true, timeout: 120000 });
console.log(JSON.stringify({ artifact: path.relative(root, archive).replaceAll('\\', '/'), files: files.length, bytes: (await fs.stat(archive)).size }));
