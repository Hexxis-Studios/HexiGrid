import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPackageIdentity, verifyPublisherSignature } from '../lib/plugin-security.mjs';

const [sourceArgument, privateKeyArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !privateKeyArgument || !outputArgument) {
  console.error('Usage: npm run plugin:package -- <source-folder> <ed25519-private-key.pem> <new-output-folder>');
  process.exit(2);
}

const source = path.resolve(sourceArgument);
const privateKeyPath = path.resolve(privateKeyArgument);
const output = path.resolve(outputArgument);
if (source === output || output.startsWith(`${source}${path.sep}`)) throw new Error('The output folder must be separate from the source folder.');
try { await fs.lstat(output); throw new Error('The output folder already exists. Choose a new empty path.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const rawManifest = JSON.parse(await fs.readFile(path.join(source, 'plugin.json'), 'utf8'));
if (!rawManifest.publisher?.id) throw new Error('Signed packages need publisher.id and publisher.name in plugin.json.');
const privateKey = crypto.createPrivateKey(await fs.readFile(privateKeyPath, 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The private key must be Ed25519.');
const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

const files = [];
async function collect(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be packaged: ${relativePath}`);
    if (stat.isDirectory()) await collect(absolute, relativePath);
    else if (stat.isFile() && relativePath !== 'plugin.json') files.push({ path: relativePath, content: await fs.readFile(absolute, 'utf8') });
    else if (!stat.isFile()) throw new Error(`Unsupported package entry: ${relativePath}`);
  }
}
await collect(source);

const publisher = { ...rawManifest.publisher, publicKey, signature: 'AA==' };
const identity = buildPackageIdentity({ ...rawManifest, publisher }, files);
const signature = crypto.sign(null, Buffer.from(identity.digest), privateKey).toString('base64');
const manifest = { ...identity.manifest, publisher: { ...publisher, signature } };
verifyPublisherSignature(manifest);

await fs.mkdir(output, { recursive: false, mode: 0o700 });
await fs.writeFile(path.join(output, 'plugin.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
for (const file of files) {
  const target = path.join(output, ...file.path.replace(/\\/g, '/').split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
}
console.log(`Signed ${manifest.id} ${manifest.version}`);
console.log(`Digest: ${manifest.package.digest}`);
console.log(`Output: ${output}`);
