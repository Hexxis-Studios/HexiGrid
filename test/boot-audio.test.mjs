import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/interactions.js', import.meta.url), 'utf8');
const preferences = await fs.readFile(new URL('../public/device-preferences.js', import.meta.url), 'utf8');

function loadInteractions(soundSetting = 'on') {
  const oscillatorStarts = [];
  let contextsCreated = 0;

  class AudioParam {
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }

  class AudioContext {
    constructor() {
      contextsCreated += 1;
      this.currentTime = 4;
      this.state = 'running';
      this.destination = {};
    }

    createOscillator() {
      return {
        type: '',
        frequency: new AudioParam(),
        connect() {},
        start(at) { oscillatorStarts.push(at); },
        stop() {}
      };
    }

    createGain() {
      return { gain: new AudioParam(), connect() {} };
    }
  }

  const storage = new Map([['hexigrid-button-sounds', soundSetting]]);
  const window = {
    AudioContext,
    addEventListener() {},
    setTimeout() {}
  };
  const context = vm.createContext({
    window,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); }
    },
    document: {
      addEventListener() {},
      querySelectorAll() { return []; }
    }
  });
  window.localStorage = context.localStorage;
  vm.runInContext(preferences, context);
  vm.runInContext(source, context);
  return { interactions: window.HexiInteractions, oscillatorStarts, contextsCreated: () => contextsCreated };
}

test('boot release audio schedules one quiet two-tone tick for every facet', () => {
  const harness = loadInteractions('on');
  harness.interactions.playFacetSequence({ count: 20, stepMs: 102 });
  assert.equal(harness.contextsCreated(), 1);
  assert.equal(harness.oscillatorStarts.length, 40);
  const primaryStarts = harness.oscillatorStarts.filter((_, index) => index % 2 === 0);
  assert.equal(primaryStarts.length, 20);
  for (let index = 1; index < primaryStarts.length; index += 1) {
    assert.ok(Math.abs(primaryStarts[index] - primaryStarts[index - 1] - .102) < 1e-9);
  }
});

test('turning button sounds off also silences the boot release sequence', () => {
  const harness = loadInteractions('off');
  harness.interactions.playFacetSequence({ count: 20, stepMs: 102 });
  assert.equal(harness.contextsCreated(), 0);
  assert.deepEqual(harness.oscillatorStarts, []);
});
