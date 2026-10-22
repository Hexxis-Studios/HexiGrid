const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_AGE_MS = 12_000;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

let latestFrame = null;

function invalidFrame(message) {
  return Object.assign(new Error(message), { status: 400, code: 'DESKTOP_FRAME_INVALID' });
}

function decodedSize(value) {
  return Math.ceil(String(value || '').replace(/\s/g, '').length * 3 / 4);
}

function normalizeMime(value) {
  const mime = String(value || '').toLowerCase().trim();
  return ALLOWED_MIME_TYPES.has(mime) ? mime : '';
}

function normalizeCapturedAt(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function publishBrowserDesktopFrame({ mimeType, data, capturedAt } = {}) {
  const mime = normalizeMime(mimeType);
  if (!mime || typeof data !== 'string' || !data.trim()) throw invalidFrame('The owner browser sent an invalid screen frame.');
  const encoded = data.replace(/\s/g, '');
  if (decodedSize(encoded) < 1 || decodedSize(encoded) > MAX_FRAME_BYTES) throw invalidFrame('The owner browser screen frame is too large.');
  latestFrame = { mimeType: mime, data: Buffer.from(encoded, 'base64'), capturedAt: normalizeCapturedAt(capturedAt), source: 'owner-browser' };
  return { capturedAt: latestFrame.capturedAt, source: latestFrame.source };
}

export function readBrowserDesktopFrame() {
  if (!latestFrame) return null;
  if (Date.now() - Date.parse(latestFrame.capturedAt) > MAX_FRAME_AGE_MS) return null;
  return { ...latestFrame, data: Buffer.from(latestFrame.data) };
}

export function clearBrowserDesktopFrame() {
  latestFrame = null;
}

export function resetBrowserDesktopFrameForTests() {
  latestFrame = null;
}
