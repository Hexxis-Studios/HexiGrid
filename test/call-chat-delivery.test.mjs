import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../integrations/call-browser/extension/muse.js', import.meta.url), 'utf8');

function harness({ url = 'https://muse.ai/thread/selected', draft = '' } = {}) {
  let listener;
  const observers = new Set();
  class TextArea {
    get value() { return this.draft || ''; }
    set value(value) { this.draft = value; }
    dispatchEvent() {}
  }
  const composer = new TextArea(); composer.value = draft;
  const log = { innerText: 'Caller ID: paired-owner\n\nHello again' };
  const submissions = [], receipts = [];
  const button = { disabled: false, click() { submissions.push(composer.value); } };
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    location: { href: url }, HTMLTextAreaElement: TextArea,
    Event: class {}, queueMicrotask: fn => fn(), setTimeout: () => 1, clearTimeout() {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    document: { body: {}, querySelector(selector) {
      return selector.startsWith('textarea') ? composer : selector.startsWith('button') ? button : log;
    } }
  });
  vm.runInContext(source, context);
  return { composer, log, submissions, receipts,
    deliver() { return listener({ type: 'call-utterance', selection: { url: 'https://muse.ai/thread/selected' },
      turn: { callId: 'private-call-id', id: 'private-turn-id', text: 'Hello again' } }, {}, x => receipts.push(x)); },
    mutate() { for (const observer of [...observers]) observer.callback(); }
  };
}

test('visible transcript contains only paired caller identity and speech; duplicate speech requires a new receipt', () => {
  const h = harness();
  assert.equal(h.deliver(), true);
  assert.deepEqual(h.submissions, ['Caller ID: paired-owner\n\nHello again']);
  h.composer.value = '';
  h.mutate();
  assert.equal(h.receipts.length, 0, 'a previous identical transcript cannot confirm this submission');
  h.log.innerText += '\nCaller ID: paired-owner\n\nHello again';
  h.mutate();
  assert.equal(h.receipts[0].submitted, true);
  h.mutate();
  assert.equal(h.receipts.length, 1);
});

test('another conversation and an existing human draft remain untouched', () => {
  for (const setup of [{ url: 'https://muse.ai/thread/other' }, { draft: 'Human draft' }]) {
    const h = harness(setup); h.deliver();
    assert.equal(h.submissions.length, 0);
    assert.equal(h.receipts[0].untouched, true);
    assert.equal(h.composer.value, setup.draft || '');
  }
});
