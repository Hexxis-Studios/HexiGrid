import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'public');
const brandMark = await readFile(path.join(output, 'brand-icosahedron.svg'), 'utf8');
const edgePath = brandMark.match(/<path d="([^"]+)" stroke-width="3\.2" opacity="\.9"\/>/)?.[1];
if (!edgePath) throw new Error('The family brand SVG needs its wireframe edge path.');

function parseEdges(d) {
  const tokens = d.match(/[ML]|-?(?:\d+\.?\d*|\.\d+)/g) || [];
  const edges = []; let current = null; let command = null;
  for (let index = 0; index < tokens.length;) {
    if (tokens[index] === 'M' || tokens[index] === 'L') { command = tokens[index++]; if (command === 'M') current = null; continue; }
    const point = [Number(tokens[index++]), Number(tokens[index++])];
    if (command === 'M' && !current) current = point;
    else { if (current) edges.push([current, point]); current = point; command = 'L'; }
  }
  return edges;
}

const edges = parseEdges(edgePath);
const nodes = [...brandMark.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/>/g)]
  .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
const brandStops = [[0, [115,245,224]], [.28, [241,244,255]], [.55, [139,124,255]], [.78, [255,202,122]], [1, [115,245,224]]];

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const body = Buffer.concat([name, data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); }
function png(width, height, pixels) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function blend(pixels, width, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= width || y >= pixels.length / width / 4) return;
  const i = (y * width + x) * 4, a = Math.max(0, Math.min(1, alpha));
  for (let c = 0; c < 3; c += 1) pixels[i + c] = Math.round(pixels[i + c] * (1 - a) + color[c] * a);
  pixels[i + 3] = 255;
}
function brandColorAt(x, y, width, height) {
  const angle = 110 * Math.PI / 180, dx = Math.sin(angle), dy = -Math.cos(angle);
  const projections = [[0, 0], [width, 0], [0, height], [width, height]].map(([px, py]) => px * dx + py * dy);
  const position = Math.max(0, Math.min(1, ((x * dx + y * dy) - Math.min(...projections)) / (Math.max(...projections) - Math.min(...projections))));
  const stopIndex = brandStops.findIndex(([at]) => at >= position);
  if (stopIndex <= 0) return brandStops[0][1];
  const [start, first] = brandStops[stopIndex - 1], [end, second] = brandStops[stopIndex];
  const amount = (position - start) / (end - start);
  return first.map((channel, index) => Math.round(channel + (second[index] - channel) * amount));
}
function render(width, height, { maskable = false, splash = false } = {}) {
  const pixels = Buffer.alloc(width * height * 4); const min = Math.min(width, height), cx = width / 2, cy = height / 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, radial = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / (min * 0.82));
    pixels[i] = 7 + Math.round(radial * 9); pixels[i + 1] = 9 + Math.round(radial * 8); pixels[i + 2] = 16 + Math.round(radial * 17); pixels[i + 3] = 255;
  }
  const logoSize = min * (splash ? 0.16 : 0.82), logoScale = logoSize / 256, logoX = cx - logoSize / 2, logoY = cy - (splash ? min * 0.04 : 0), logoTop = logoY - logoSize / 2;
  const line = (x1, y1, x2, y2, thickness, alpha = 1) => {
    const left = Math.floor(Math.min(x1, x2) - thickness * 3), right = Math.ceil(Math.max(x1, x2) + thickness * 3), top = Math.floor(Math.min(y1, y2) - thickness * 3), bottom = Math.ceil(Math.max(y1, y2) + thickness * 3), vx = x2 - x1, vy = y2 - y1, length2 = vx * vx + vy * vy;
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) { const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / length2)); const distance = Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)); if (distance < thickness * 3) blend(pixels, width, x, y, brandColorAt(x, y, width, height), Math.max(0, 1 - distance / (thickness * 3)) * alpha * .2); if (distance < thickness) blend(pixels, width, x, y, brandColorAt(x, y, width, height), Math.max(0, 1 - distance / thickness) * alpha); }
  };
  for (const [[x1, y1], [x2, y2]] of edges) {
    line(logoX + x1 * logoScale, logoTop + y1 * logoScale, logoX + x2 * logoScale, logoTop + y2 * logoScale, 3.2 * logoScale, .9);
  }
  for (const [x, y, radius] of nodes) {
    const nodeX = logoX + x * logoScale, nodeY = logoTop + y * logoScale, nodeRadius = radius * logoScale;
    for (let py = Math.floor(nodeY - nodeRadius * 3); py <= nodeY + nodeRadius * 3; py += 1) for (let px = Math.floor(nodeX - nodeRadius * 3); px <= nodeX + nodeRadius * 3; px += 1) {
      const distance = Math.hypot(px + .5 - nodeX, py + .5 - nodeY);
      if (distance < nodeRadius * 3) blend(pixels, width, px, py, [115,245,224], Math.max(0, 1 - distance / (nodeRadius * 3)) * .18);
      if (distance < nodeRadius) blend(pixels, width, px, py, [228,255,251], .92);
      else if (distance < nodeRadius + .65 * logoScale) blend(pixels, width, px, py, brandColorAt(px, py, width, height), .92);
    }
  }
  if (!maskable && !splash) {
    const radius = min * .21;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const dx = Math.max(radius - x, 0, x - (width - radius)), dy = Math.max(radius - y, 0, y - (height - radius)); if (dx * dx + dy * dy > radius * radius) pixels[(y * width + x) * 4 + 3] = 0; }
  }
  return png(width, height, pixels);
}

await mkdir(output, { recursive: true });
for (const [name, width, height, options] of [
  ['icon-192.png', 192, 192, {}], ['icon-512.png', 512, 512, {}],
  ['icon-maskable-192.png', 192, 192, { maskable: true }], ['icon-maskable-512.png', 512, 512, { maskable: true }],
  ['apple-touch-icon-180.png', 180, 180, { maskable: true }],
  ['splash-1170x2532.png', 1170, 2532, { splash: true }], ['splash-2048x2732.png', 2048, 2732, { splash: true }]
]) await writeFile(path.join(output, name), render(width, height, options));
