// Reuses the loopback-only, fixed-asset pattern from accept-vrm-viewer.mjs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function createPracticeServer() {
  const assets = new Map(await Promise.all([
    ['/', 'agent-practice.html', 'text/html; charset=utf-8'],
    ['/practice.js', 'agent-practice.js', 'text/javascript; charset=utf-8']
  ].map(async ([route, file, type]) => [route, { type, body: await readFile(new URL(`../qa-assets/${file}`, import.meta.url)) }])));
  return http.createServer((req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" };
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) { res.writeHead(403, headers); res.end('Local practice address only.'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { ...headers, allow: 'GET, HEAD' }); res.end(); return; }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404, headers); res.end('Not found'); return; }
    res.writeHead(200, { ...headers, 'content-type': asset.type, 'content-length': asset.body.length });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createPracticeServer();
  server.listen(0, '127.0.0.1', () => console.log(`HexiGrid Agent Practice: http://127.0.0.1:${server.address().port}/`));
  process.stdin.resume();
  process.stdin.on('data', data => { if (String(data).trim() === 'stop') server.close(() => process.exit(0)); });
}
