import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactDownloadHeaders, artifactPublicSummary, artifactQuotaSummary, authenticateHexiSpaceArtifact, createHexiSpaceArtifact, normalizeHexiSpaceArtifacts, pruneExpiredHexiSpaceArtifacts, safeArtifactPreview } from '../lib/hexispace-artifacts.mjs';

const state = () => ({ hexispace: { artifacts: [] } });
const encoded = (value) => Buffer.from(value).toString('base64');

test('HexiSpace artifacts require explicit consent and produce scoped expiring links', () => {
  const current = state();
  assert.throws(() => createHexiSpaceArtifact(current, { linkId: 'link-a', filename: 'note.txt', mimeType: 'text/plain', contentBase64: encoded('private'), consent: false }), /consent/i);
  const created = createHexiSpaceArtifact(current, { linkId: 'link-a', filename: '../../private.txt', mimeType: 'text/plain', contentBase64: encoded('private'), consent: true, expiresInSeconds: 999999 });
  assert.equal(created.record.downloadName, 'private.txt');
  assert.equal(created.record.bytes, 7);
  assert.ok(created.record.expiresAt);
  assert.equal(authenticateHexiSpaceArtifact(current, created.record.id, created.token).linkId, 'link-a');
  assert.throws(() => authenticateHexiSpaceArtifact(current, created.record.id, 'wrong-token'), /invalid or expired/i);
  assert.deepEqual(artifactQuotaSummary(current, 'link-a'), { linkBytes: 7, totalBytes: 7, linkLimitBytes: 50 * 1024 * 1024, totalLimitBytes: 200 * 1024 * 1024, activeArtifacts: 1 });
});

test('artifact normalization expires stale files and preview never emits executable markup', () => {
  const current = state();
  const created = createHexiSpaceArtifact(current, { linkId: 'link-a', filename: 'payload.json', mimeType: 'application/json', contentBase64: encoded('{"ok":true}'), consent: true, expiresInSeconds: 300 }, 1_000_000);
  assert.deepEqual(safeArtifactPreview(created.record, created.bytes), { kind: 'text', text: '{"ok":true}', truncated: false });
  const image = { ...created.record, mimeType: 'image/png' };
  assert.deepEqual(safeArtifactPreview(image, Buffer.from('<script>alert(1)</script>')), { kind: 'download-only', text: '', truncated: false });
  assert.equal(normalizeHexiSpaceArtifacts(current, Date.parse(created.record.expiresAt) + 1).length, 1);
  assert.equal(pruneExpiredHexiSpaceArtifacts(current, Date.parse(created.record.expiresAt) + 1).length, 1);
  assert.equal(current.hexispace.artifacts.length, 0);
});

test('artifact delivery is attachment-only and isolated from active content', () => {
  const headers = artifactDownloadHeaders({ mimeType: 'text/plain', bytes: 10 }, '" onclick="alert(1)');
  assert.equal(headers['content-disposition'], 'attachment; filename="onclickalert1"');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.match(headers['content-security-policy'], /sandbox/);
  assert.equal(headers['cache-control'], 'no-store');
});

test('artifact MIME and quota boundaries fail closed', () => {
  const current = state();
  assert.throws(() => createHexiSpaceArtifact(current, { linkId: 'link-a', filename: 'page.html', mimeType: 'text/html', contentBase64: encoded('<script>bad</script>'), consent: true }), /not supported/i);
  for (let index = 0; index < 5; index += 1) current.hexispace.artifacts.push({ id: `artifact-existing-${index}`, linkId: 'link-a', filename: `artifact-existing-${index}.bin`, downloadName: 'existing', mimeType: 'text/plain', bytes: 10 * 1024 * 1024, tokenHash: 'a'.repeat(43), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), downloadCount: 0, consentedAt: new Date().toISOString() });
  assert.throws(() => createHexiSpaceArtifact(current, { linkId: 'link-a', filename: 'too-large.txt', mimeType: 'text/plain', contentBase64: encoded('xx'), consent: true }), /50 MB artifact quota/i);
});

test('provider-hosted artifacts stay link-scoped and never enter the local byte quota', () => {
  const current = state();
  const created = createHexiSpaceArtifact(current, {
    linkId: 'link-provider', filename: 'landing.html', mimeType: 'text/html',
    providerUrl: 'https://provider.example/artifacts/landing.html', providerName: 'Example provider', consent: true
  });
  assert.equal(created.record.source, 'provider');
  assert.equal(created.record.bytes, 0);
  assert.equal(created.bytes.length, 0);
  assert.equal(created.record.providerUrl, 'https://provider.example/artifacts/landing.html');
  assert.equal(artifactQuotaSummary(current, 'link-provider').linkBytes, 0);
  assert.deepEqual(safeArtifactPreview(created.record, Buffer.alloc(0)), { kind: 'external-link', text: '', truncated: false });
  assert.deepEqual(artifactPublicSummary(created.record), {
    id: created.record.id, source: 'provider', filename: 'landing.html', mimeType: 'text/html', bytes: 0,
    createdAt: created.record.createdAt, expiresAt: created.record.expiresAt,
    providerName: 'Example provider', externalUrl: 'https://provider.example/artifacts/landing.html'
  });
  assert.throws(() => createHexiSpaceArtifact(current, { linkId: 'link-provider', mimeType: 'text/html', providerUrl: 'http://127.0.0.1/private', consent: true }), /ordinary HTTPS|private|local/i);
});
