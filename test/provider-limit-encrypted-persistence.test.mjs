import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commitProviderLimitPatch } from '../lib/provider-limits.mjs';
import { createStateSaveQueue, EncryptedStateStore } from '../lib/local-state.mjs';

test('provider output limit survives the encrypted state write and a fresh store read', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-provider-limits-'));
  try {
    const file = path.join(directory, 'state.json');
    const keyEntries = new Map();
    const vault = {
      isAvailable: () => true,
      async get(key) { return keyEntries.get(key); },
      async set(key, value) { keyEntries.set(key, value); }
    };
    const store = new EncryptedStateStore(file, vault);
    const provider = {
      id: 'provider-local-test', name: 'Synthetic local provider',
      baseUrl: 'http://127.0.0.1:9999/v1', modelIds: ['synthetic-model'],
      apiKey: 'synthetic-key-never-transmitted', hasKey: true,
      maxInputTokens: 12000, maxOutputTokens: 2048, enabled: true
    };
    const state = {
      version: 2, providers: [provider], receipts: [], activity: [],
      settings: { model: 'provider-local-test:synthetic-model' }
    };
    await store.write(state);
    const saveState = createStateSaveQueue({ getState: () => state, store });

    const result = await commitProviderLimitPatch(state, provider, { maxOutputTokens: 256 }, {
      addReceipt(values) {
        const receipt = { id: 'synthetic-receipt', ...values };
        state.receipts.unshift(receipt);
        return receipt;
      },
      saveState
    });

    assert.equal(result.provider.maxOutputTokens, 256);
    assert.equal(result.receipt.status, 'completed');
    const encryptedFile = await readFile(file, 'utf8');
    assert.match(encryptedFile, /"format":"hexigrid-local-state"/);
    assert.doesNotMatch(encryptedFile, /synthetic-key-never-transmitted|synthetic-model/);

    const reloaded = await new EncryptedStateStore(file, vault).read();
    assert.equal(reloaded.providers[0].maxOutputTokens, 256);
    assert.equal(reloaded.providers[0].maxInputTokens, 12000);
    assert.equal(reloaded.providers[0].apiKey, 'synthetic-key-never-transmitted');
    assert.equal(reloaded.settings.model, 'provider-local-test:synthetic-model');
    assert.equal(reloaded.receipts[0].action, 'provider:provider-local-test:limits');
    assert.equal(reloaded.receipts[0].status, 'completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
