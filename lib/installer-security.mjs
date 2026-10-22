import crypto from 'node:crypto';

export const ILANDS_GUIDE_URL = 'https://ilands.ai/agent.md';
const MAX_GUIDE_BYTES = 512 * 1024;
const PLAN_TTL_MS = 10 * 60 * 1000;
const PLATFORM_KEYS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
const HARNESSES = new Set(['claude-code', 'codex', 'openclaw', 'hermes', 'pi']);

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

export function nativePlatformKey(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : '';
  const key = normalizedArch && ['win32', 'darwin', 'linux'].includes(platform) ? `${platform}-${normalizedArch}` : '';
  return PLATFORM_KEYS.has(key) ? key : '';
}

export function parseIlandsGuide(markdown, { platform = process.platform, arch = process.arch } = {}) {
  const text = String(markdown || '');
  if (!text.startsWith('# Connect this agent to iLands') || text.length < 1000 || Buffer.byteLength(text) > MAX_GUIDE_BYTES) throw new Error('The official iLands setup guide was missing, malformed, or too large.');
  const release = text.match(/The live release is \*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/)?.[1];
  if (!release) throw new Error('The official iLands guide did not publish a valid release version.');
  const platformKey = nativePlatformKey(platform, arch);
  if (!platformKey) throw new Error(`iLands Runner does not publish a certified build for ${platform}-${arch}.`);
  const escaped = platformKey.replace('-', '\\-');
  const line = text.match(new RegExp('^- `' + escaped + '`: ([^\\r\\n]+)$', 'm'))?.[1] || '';
  const supportedHarnesses = [...line.matchAll(/`(claude-code|codex|openclaw|hermes|pi)`/g)].map((match) => match[1]);
  if (!supportedHarnesses.length) throw new Error(`The live iLands guide does not publish a Runner for ${platformKey}.`);
  if (platformKey === 'win32-x64' && !/interactive_host_handoff_required/.test(text)) throw new Error('The Windows host-handoff instructions are missing from the live guide.');
  return { release, platformKey, supportedHarnesses: [...new Set(supportedHarnesses)] };
}

export async function fetchIlandsGuide({ fetcher = fetch, platform = process.platform, arch = process.arch } = {}) {
  const response = await fetcher(ILANDS_GUIDE_URL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'text/markdown, text/plain;q=0.9' } }).catch(() => { throw new Error('The official iLands setup guide could not be reached securely.'); });
  if (!response?.ok || response.url && response.url !== ILANDS_GUIDE_URL) throw new Error('The official iLands setup guide returned an unexpected response.');
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.startsWith('text/markdown') && !type.startsWith('text/plain')) throw new Error('The official iLands setup guide returned an unexpected content type.');
  if (Number(response.headers?.get?.('content-length') || 0) > MAX_GUIDE_BYTES) throw new Error('The official iLands setup guide exceeded the safe download limit.');
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_GUIDE_BYTES) throw new Error('The official iLands setup guide exceeded the safe download limit.');
  const markdown = bytes.toString('utf8'); return { ...parseIlandsGuide(markdown, { platform, arch }), guideDigest: digest(bytes), guideBytes: bytes.length, fetchedAt: new Date().toISOString() };
}

export function createIlandsSetupPlan(guide, harness, { now = Date.now(), randomUUID = crypto.randomUUID } = {}) {
  if (!guide?.supportedHarnesses?.includes(harness) || !HARNESSES.has(harness)) throw new Error(`${harness || 'That harness'} is not certified for ${guide?.platformKey || 'this platform'} in the live iLands guide.`);
  return { id: `ilands-plan-${randomUUID()}`, guideDigest: guide.guideDigest, release: guide.release, platformKey: guide.platformKey, harness, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(), consumedAt: null };
}

export function verifyIlandsSetupPlan(plan, currentGuide, request, now = Date.now()) {
  if (!plan || plan.consumedAt) throw new Error('This iLands setup plan is missing or was already used. Check the live guide again.');
  if (Date.parse(plan.expiresAt) <= now) throw new Error('This iLands setup plan expired. Check the live guide again.');
  if (request?.guideDigest !== plan.guideDigest || request?.harness !== plan.harness) throw new Error('The approved iLands setup details do not match this plan.');
  if (currentGuide.guideDigest !== plan.guideDigest || currentGuide.release !== plan.release || currentGuide.platformKey !== plan.platformKey || !currentGuide.supportedHarnesses.includes(plan.harness)) throw new Error('The live iLands setup guide changed after review. Review the new guide before continuing.');
  return true;
}

export function publicIlandsSetupPlan(plan) {
  return { id: plan.id, guideDigest: plan.guideDigest, release: plan.release, platformKey: plan.platformKey, harness: plan.harness, createdAt: plan.createdAt, expiresAt: plan.expiresAt, guideUrl: ILANDS_GUIDE_URL };
}
