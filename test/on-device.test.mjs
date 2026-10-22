import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnDeviceProvider, isOnDeviceModel, isOnDeviceProvider, normalizeOnDeviceModels, sanitizeOnDeviceProvider } from '../lib/on-device.mjs';

test('on-device model records are normalized, deduplicated, and bounded', () => {
  const models = normalizeOnDeviceModels([
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Small model', vramRequiredMB: 900.4, lowResource: true },
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Updated label' },
    { id: 'not valid/model' },
    'Phi-3.5-mini-instruct-q4f16_1-MLC'
  ]);
  assert.deepEqual(models.map((model) => model.id), ['Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Phi-3.5-mini-instruct-q4f16_1-MLC']);
  assert.equal(models[0].label, 'Updated label');
  assert.equal(models[0].lowResource, false);
  assert.throws(() => normalizeOnDeviceModels([]), /at least one/);
});

test('on-device provider contains no credential fields and accepts only browser models', () => {
  const provider = createOnDeviceProvider({
    name: 'My browser',
    deviceId: 'browser-12345678',
    models: [{ id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi mini' }],
    apiKey: 'must-not-be-stored'
  }, { id: 'provider-browser-test', createdAt: '2026-09-14T00:00:00.000Z' });
  assert.equal(isOnDeviceProvider(provider), true);
  assert.equal(isOnDeviceModel(provider.modelIds[0], provider), true);
  assert.equal(provider.hasKey, false);
  assert.equal('apiKey' in provider, false);
  assert.equal(provider.baseUrl, 'browser://webllm');
  const sanitized = sanitizeOnDeviceProvider({ ...provider, apiKey: 'must-not-leak', hasKey: true });
  assert.equal(sanitized.hasKey, false);
  assert.equal('apiKey' in sanitized, false);
});
