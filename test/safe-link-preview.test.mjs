import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSafeLinkPreview } from '../lib/safe-link-preview.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body, headers = { 'content-type': 'text/html' }, status = 200) => new Response(body, { status, headers });

test('safe preview fetch bounds metadata and sanitizes hostile OG values', async () => {
  const result = await fetchSafeLinkPreview('https://example.test/article', {
    lookup: publicLookup,
    fetcher: async () => response('<title>Good</title><meta property="og:description" content="<img src=x> hello"><meta property="og:image" content="data:text/html,pwn">')
  });
  assert.equal(result.title, 'Good');
  assert.equal(result.description, 'hello');
  assert.equal(result.image, '');
});

test('safe preview blocks private literals, DNS results, redirects, and non-HTML bytes', async () => {
  await assert.rejects(() => fetchSafeLinkPreview('https://127.0.0.1/a', { lookup: publicLookup, fetcher: async () => response('') }), /Private or local/);
  await assert.rejects(() => fetchSafeLinkPreview('https://[::1]/a', { lookup: publicLookup, fetcher: async () => response('') }), /Private or local/);
  await assert.rejects(() => fetchSafeLinkPreview('https://[fc00::1]/a', { lookup: publicLookup, fetcher: async () => response('') }), /Private or local/);
  await assert.rejects(() => fetchSafeLinkPreview('https://[::ffff:127.0.0.1]/a', { lookup: publicLookup, fetcher: async () => response('') }), /Private or local/);
  await assert.rejects(() => fetchSafeLinkPreview('https://example.test/a', { lookup: async () => [{ address: '10.0.0.2', family: 4 }], fetcher: async () => response('') }), /private or local/);
  await assert.rejects(() => fetchSafeLinkPreview('https://example.test/a', { lookup: publicLookup, fetcher: async () => response('', { location: 'https://169.254.169.254/latest', 'content-type': 'text/html' }, 302) }), /Private or local/);
  await assert.rejects(() => fetchSafeLinkPreview('https://example.test/a', { lookup: publicLookup, fetcher: async () => response('video', { 'content-type': 'video/mp4' }) }), /HTML metadata/);
});
