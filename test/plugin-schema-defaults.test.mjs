import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePluginManifest, buildPackageIdentity } from '../lib/plugin-security.mjs';

function manifest(properties) {
  return { schemaVersion: 2, id: 'defaults-qa', name: 'Defaults QA', version: '1.0.0', entry: 'plugin.mjs', capabilities: [{ id: 'calculate', label: 'Calculate', risk: 'low', inputSchema: { type: 'object', properties } }] };
}
test('validated plugin schema retains scalar and structured defaults including zero, false and empty text', () => {
  const original = manifest({ number: { type: 'number', default: 0 }, toggle: { type: 'boolean', default: false }, text: { type: 'string', default: '' }, object: { type: 'object', properties: { a: { type: 'integer' } }, default: { a: 2 } }, list: { type: 'array', items: { type: 'string' }, default: ['a'] } });
  const schema = validatePluginManifest(original).capabilities[0].inputSchema;
  assert.equal(schema.properties.number.default, 0);
  assert.equal(schema.properties.toggle.default, false);
  assert.equal(schema.properties.text.default, '');
  assert.deepEqual(schema.properties.object.default, { a: 2 });
  assert.deepEqual(schema.properties.list.default, ['a']);
  original.capabilities[0].inputSchema.properties.object.default.a = 99;
  assert.equal(schema.properties.object.default.a, 2);
});
test('invalid or oversized defaults are rejected before any plugin is installed', () => {
  for (const property of [{ type: 'number', default: '2' }, { type: 'integer', minimum: 1, default: 0 }, { type: 'string', enum: ['yes'], default: 'no' }, { type: 'object', properties: {}, default: { undeclared: true } }, { type: 'string', default: 'x'.repeat(4097) }]) {
    assert.throws(() => validatePluginManifest(manifest({ value: property })), /default|undeclared/i);
  }
});
test('package identity covers defaults and remains stable when normalized again', () => {
  const files = [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async()=>({})};' }];
  const identity = buildPackageIdentity(manifest({ value: { type: 'number', default: 2 } }), files);
  assert.equal(buildPackageIdentity(identity.manifest, files).digest, identity.digest);
  assert.notEqual(buildPackageIdentity(manifest({ value: { type: 'number', default: 3 } }), files).digest, identity.digest);
});
