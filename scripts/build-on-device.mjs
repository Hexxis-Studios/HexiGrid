import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageBundle = path.join(root, 'node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js');
const vendorDir = path.join(root, 'public', 'vendor');
const vendorBundle = path.join(vendorDir, 'web-llm.js');
const workerFile = path.join(root, 'public', 'on-device-worker.js');

await fs.mkdir(vendorDir, { recursive: true });
const source = await fs.readFile(packageBundle, 'utf8');
const bundle = source.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*$/, '\n');
await fs.writeFile(vendorBundle, bundle, 'utf8');
await fs.writeFile(workerFile, `import { WebWorkerMLCEngineHandler } from '/vendor/web-llm.js';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event) => handler.onmessage(event);
`, 'utf8');
console.log(`Built browser inference runtime from @mlc-ai/web-llm ${JSON.parse(await fs.readFile(path.join(root, 'node_modules', '@mlc-ai', 'web-llm', 'package.json'), 'utf8')).version}.`);
