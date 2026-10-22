import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIlandsSetupPlan, fetchIlandsGuide, parseIlandsGuide, verifyIlandsSetupPlan } from '../lib/installer-security.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const padding = 'Certified setup details. '.repeat(60);
const guideText = `# Connect this agent to iLands\n\n${padding}\nThe live release is **v1.2.3**.\n- \`darwin-arm64\`: \`claude-code\`, \`codex\`, \`openclaw\`, \`hermes\`, \`pi\`\n- \`darwin-x64\`: \`claude-code\`, \`codex\`, \`openclaw\`, \`hermes\`, \`pi\`\n- \`linux-arm64\`: \`claude-code\`, \`codex\`, \`openclaw\`, \`hermes\`, \`pi\`\n- \`linux-x64\`: \`claude-code\`, \`codex\`, \`openclaw\`, \`hermes\`, \`pi\`\n- \`win32-x64\`: \`claude-code\`, \`codex\`\ninteractive_host_handoff_required\n`;

test('iLands installer guide parsing enforces exact platform and harness publication', () => {
  const windows = parseIlandsGuide(guideText, { platform: 'win32', arch: 'x64' });
  assert.equal(windows.release, '1.2.3'); assert.deepEqual(windows.supportedHarnesses, ['claude-code', 'codex']);
  assert.throws(() => createIlandsSetupPlan({ ...windows, guideDigest: 'a'.repeat(64) }, 'openclaw'), /not certified/);
  assert.throws(() => parseIlandsGuide(guideText, { platform: 'win32', arch: 'arm64' }), /does not publish|certified build/);
  assert.throws(() => parseIlandsGuide(guideText.replace('interactive_host_handoff_required', 'missing')), /handoff instructions/);
});

test('iLands guide retrieval rejects redirects, wrong media, oversize data, and changed approval plans', async () => {
  const goodFetch = async () => new Response(guideText, { status: 200, headers: { 'content-type': 'text/markdown' } });
  const guide = await fetchIlandsGuide({ fetcher: goodFetch, platform: 'win32', arch: 'x64' }); assert.match(guide.guideDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(fetchIlandsGuide({ fetcher: async () => ({ ok: true, url: 'https://example.invalid/agent.md', headers: new Headers({ 'content-type': 'text/markdown' }), arrayBuffer: async () => Buffer.from(guideText) }), platform: 'win32', arch: 'x64' }), /unexpected response/);
  await assert.rejects(fetchIlandsGuide({ fetcher: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), platform: 'win32', arch: 'x64' }), /content type/);
  await assert.rejects(fetchIlandsGuide({ fetcher: async () => new Response('x'.repeat(512 * 1024 + 1), { status: 200, headers: { 'content-type': 'text/markdown' } }), platform: 'win32', arch: 'x64' }), /safe download limit/);
  const now = Date.now(); const plan = createIlandsSetupPlan(guide, 'codex', { now, randomUUID: () => '00000000-0000-4000-8000-000000000000' });
  assert.equal(verifyIlandsSetupPlan(plan, guide, { guideDigest: guide.guideDigest, harness: 'codex' }, now + 1), true);
  assert.throws(() => verifyIlandsSetupPlan(plan, { ...guide, guideDigest: 'b'.repeat(64) }, { guideDigest: guide.guideDigest, harness: 'codex' }, now + 1), /changed after review/);
  assert.throws(() => verifyIlandsSetupPlan(plan, guide, { guideDigest: guide.guideDigest, harness: 'codex' }, now + 11 * 60 * 1000), /expired/);
  plan.consumedAt = new Date().toISOString(); assert.throws(() => verifyIlandsSetupPlan(plan, guide, { guideDigest: guide.guideDigest, harness: 'codex' }, now + 1), /already used/);
});

test('installer and launcher sources contain no remote-code execution shortcut', async () => {
  const sources = await Promise.all(['server.mjs', 'Start-Control-Room.ps1', 'public/integrations.js'].map((file) => readFile(path.join(root, file), 'utf8')));
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /irm\s+https?:\/\/[^|]+\|\s*iex/i);
  assert.doesNotMatch(combined, /curl\s+[^\r\n|]+\|\s*(sh|bash)/i);
  assert.doesNotMatch(combined, /ExecutionPolicy["'\s,]+Bypass/i);
  assert.doesNotMatch(combined, /spawn\(['"]powershell(?:\.exe)?['"][\s\S]{0,500}install/i);
});
