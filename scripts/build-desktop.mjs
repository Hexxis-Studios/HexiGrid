import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { prepareLocalRelease } from './prepare-local-release.mjs';
import { BRAND } from '../lib/brand.mjs';
import { runtimeSourceDigest } from '../lib/runtime-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const NODE_VERSION = '24.14.0';
const platform = process.platform;
const rid = platform === 'win32' ? 'win-x64' : platform === 'linux' ? 'linux-x64' : null;
if (!rid || process.arch !== 'x64') throw new Error('Desktop packaging currently supports Windows x64 and Linux x64.');

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, 'releases', `${platform === 'win32' ? 'windows' : 'linux'}-${pkg.version}-${stamp}`);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output, { recursive: false });
const stage = path.join(output, 'build');
await fs.mkdir(stage);
const shellRoot = path.join(stage, 'shell');
await fs.mkdir(shellRoot);
for (const file of ['main.cjs', 'preload.cjs', 'engine.cjs', 'policy.cjs', 'autostart.cjs', 'package.json']) {
  await fs.copyFile(path.join(root, 'desktop', file), path.join(shellRoot, file));
}
const shellPackage = JSON.parse(await fs.readFile(path.join(shellRoot, 'package.json'), 'utf8'));
shellPackage.version = pkg.version;
shellPackage.productName = BRAND.name;
if (platform === 'linux') {
  shellPackage.desktopName = BRAND.name.toLowerCase();
  shellPackage.homepage = 'https://github.com/Hexxis-Studios/HexiGrid';
}
await fs.writeFile(path.join(shellRoot, 'package.json'), JSON.stringify(shellPackage, null, 2));

console.log('Preparing the allowlisted application with production dependencies.');
const engineId = `desktop-engine-${platform}-${stamp}`;
await prepareLocalRelease({ sourceRoot: root, managerRoot: root, id: engineId, installDependencies: true });
const engineRoot = path.join(root, 'releases', engineId);

console.log('Building the self-contained browser-call companion.');
const nativeOutput = path.join(engineRoot, 'integrations/call-browser/native-host');
await promisify(execFile)('dotnet', ['publish', path.join(engineRoot, 'integrations/call-browser/native/CallChatHost.csproj'),
  '-c', 'Release', '-r', rid, '--self-contained', 'true', '-o', nativeOutput,
  '-p:PublishSingleFile=true', '-p:DebugType=None', '-p:DebugSymbols=false',
  '-p:IncludeNativeLibrariesForSelfExtract=true', `-p:BaseIntermediateOutputPath=${path.join(stage, 'host-obj')}${path.sep}`,
  `-p:OutputPath=${path.join(stage, 'host-bin')}${path.sep}`],
{ windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
const restore = JSON.parse(await fs.readFile(path.join(stage, 'host-obj/project.assets.json'), 'utf8'));
const runtime = restore.project.frameworks.net9_0 || restore.project.frameworks['net9.0'];
const runtimePackage = `Microsoft.NETCore.App.Runtime.${rid}`;
const runtimeVersion = runtime.downloadDependencies.find(item => item.name.toLowerCase() === runtimePackage.toLowerCase())
  ?.version.replace(/[\[\] ]/g, '').split(',')[0];
if (!runtimeVersion) throw new Error('The native helper runtime package could not be verified.');
const packageCache = Object.keys(restore.packageFolders)[0];
const runtimePackageDir = path.join(packageCache, runtimePackage.toLowerCase(), runtimeVersion);
for (const name of ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT']) {
  const source = path.join(runtimePackageDir, name);
  if (await fs.stat(source).then(item => item.isFile()).catch(() => false)) await fs.copyFile(source, path.join(nativeOutput, name));
}
if (platform === 'linux') await fs.chmod(path.join(nativeOutput, 'HexiGridCallChatHost'), 0o755);

const nodeName = platform === 'win32' ? `node-v${NODE_VERSION}-win-x64.zip` : `node-v${NODE_VERSION}-linux-x64.tar.xz`;
const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
console.log(`Downloading and verifying Node.js ${NODE_VERSION} from nodejs.org.`);
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
  if (!response.ok) throw new Error('An official runtime download was unavailable.');
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await download(`${base}SHASUMS256.txt`)).toString('utf8');
const expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(` ${nodeName}`))?.split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('The official Node runtime checksum is missing.');
const bytes = await download(`${base}${nodeName}`);
if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node runtime checksum mismatch.');
const archive = path.join(stage, nodeName);
await fs.writeFile(archive, bytes, { flag: 'wx' });
const runtimeStage = path.join(stage, 'node');
await fs.mkdir(runtimeStage);
if (platform === 'win32') {
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '& { param($source,$destination) Expand-Archive -LiteralPath $source -DestinationPath $destination }', archive, runtimeStage],
  { windowsHide: true, timeout: 120000 });
} else {
  await promisify(execFile)('tar', ['-xJf', archive, '-C', runtimeStage], { timeout: 120000, maxBuffer: 1024 * 1024 });
}
const runtimeRoot = path.join(runtimeStage, `node-v${NODE_VERSION}-${rid}`);
const runtimeBinary = path.join(runtimeRoot, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
const version = await promisify(execFile)(runtimeBinary, ['--version'], { windowsHide: true });
if (version.stdout.trim() !== `v${NODE_VERSION}`) throw new Error('Bundled Node runtime identity mismatch.');

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const { build, Platform, Arch } = builder;
const target = platform === 'win32' ? Platform.WINDOWS.createTarget(['nsis'], Arch.x64) : Platform.LINUX.createTarget(['AppImage', 'deb'], Arch.x64);
const buildResources = path.join(stage, 'resources');
await fs.mkdir(buildResources);
if (platform === 'linux') {
  const iconDir = path.join(buildResources, 'linux-icons');
  await fs.mkdir(iconDir);
  await fs.copyFile(path.join(root, 'public', 'icon-512.png'), path.join(iconDir, '512x512.png'));
}
console.log(`Building the ${platform === 'win32' ? 'Windows installer' : 'Linux AppImage'}. Publishing is disabled.`);
const artifacts = await build({ projectDir: shellRoot, targets: target, publish: 'never', config: {
  appId: 'Hexxis.Studios.HexiGrid', productName: BRAND.name,
  directories: { app: shellRoot, output: path.join(output, 'artifacts'), buildResources },
  electronVersion: pkg.devDependencies.electron, npmRebuild: false, asar: true,
  files: ['main.cjs', 'preload.cjs', 'engine.cjs', 'policy.cjs', 'autostart.cjs', 'package.json'],
  extraResources: [
    { from: engineRoot, to: 'engine', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc', '!**/*.pdb',
      '!integrations/call-browser/native/bin/**', '!integrations/call-browser/native/obj/**'] },
    ...(platform === 'win32' ? [{ from: path.join(root, 'scripts', 'Set-HexiGridToastShortcut.ps1'),
      to: 'notification/Set-HexiGridToastShortcut.ps1' }] : []),
    // electron-builder deliberately excludes a root-level node_modules directory.
    // Map its contents from their own root so the self-contained engine retains its
    // production dependencies without disabling the builder's normal exclusions.
    { from: path.join(engineRoot, 'node_modules'), to: 'engine/node_modules', filter: ['**/*'] },
    ...(platform === 'win32'
      ? [{ from: runtimeRoot, to: 'runtime', filter: ['node.exe', 'LICENSE'] }]
      : [{ from: runtimeRoot, to: 'runtime', filter: ['bin/node', 'LICENSE'] }])
  ],
  ...(platform === 'win32' ? {
    win: { target: ['nsis'], icon: path.join(root, 'public', 'icon-512.png'), signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false,
      include: path.join(root, 'scripts', 'nsis', 'installer.nsh'),
      artifactName: '${productName}-Setup-${version}-${arch}.${ext}' }
  } : {
    linux: { target: ['AppImage', 'deb'], icon: path.join(buildResources, 'linux-icons'), category: 'Utility', maintainer: 'Hexxis Studios', syncDesktopName: true,
      artifactName: '${productName}-${version}-${arch}.${ext}' }
  })
} });

const unpackedDir = path.join(output, 'artifacts', platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
const packagedEngineRoot = path.join(unpackedDir, 'resources', 'engine');
const packagedNode = path.join(unpackedDir, 'resources', 'runtime', ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
await promisify(execFile)(packagedNode, ['--input-type=module', '-e', "await import('./lib/mcp-http-response.mjs')"],
  { cwd: packagedEngineRoot, windowsHide: true, timeout: 30000 });

const report = { version: pkg.version, platform, arch: 'x64', electron: pkg.devDependencies.electron,
  node: NODE_VERSION, browserHelperRuntime: runtimeVersion, nodeArchive: nodeName, nodeArchiveSha256: expected,
  sourceDigest: await runtimeSourceDigest(root), packagedSourceDigest: await runtimeSourceDigest(engineRoot),
  signed: false, published: false,
  artifacts: await Promise.all(artifacts.map(async file => ({ file: path.relative(root, file).replaceAll('\\', '/'),
    sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'), bytes: (await fs.stat(file)).size }))) };
await fs.writeFile(path.join(output, 'build-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
