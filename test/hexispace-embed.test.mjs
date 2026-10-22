import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddedDocumentHeaders, localHexiSpaceOrigins, trustedHexiSpaceEmbedOrigin } from '../lib/hexispace-embed.mjs';

test('embedded HexiGrid documents accept only the configured local HexiSpace origins', () => {
  const [loopback, localhost] = localHexiSpaceOrigins();
  assert.equal(trustedHexiSpaceEmbedOrigin({ referer: `${loopback}/#grid` }, true), loopback);
  assert.equal(trustedHexiSpaceEmbedOrigin({ origin: localhost }, true), localhost);
  assert.equal(trustedHexiSpaceEmbedOrigin({}, true, loopback), loopback);
  assert.equal(trustedHexiSpaceEmbedOrigin({}, true, 'http://127.0.0.1:4341'), '');
  assert.equal(trustedHexiSpaceEmbedOrigin({ referer: 'http://127.0.0.1:4341/#grid' }, true), '');
  assert.equal(trustedHexiSpaceEmbedOrigin({ referer: 'https://example.test/#grid' }, true), '');
  assert.equal(trustedHexiSpaceEmbedOrigin({ referer: `${loopback}/#grid` }, false), '');
});

test('embedded response policy is narrowly scoped and keeps normal pages unchanged', () => {
  assert.deepEqual(embeddedDocumentHeaders('http://127.0.0.1:4340'), {
    frameAncestors: 'http://127.0.0.1:4340',
    crossOriginResourcePolicy: 'cross-origin'
  });
  assert.deepEqual(embeddedDocumentHeaders(''), {});
});
