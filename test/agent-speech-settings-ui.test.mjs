import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

const source = await readFile(new URL('../public/agent-interface.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('  function renderSpeechSettings('), source.indexOf('  function renderDesktopBridge('));
const bindings = source.slice(source.indexOf("  document.querySelector('#agentSpeechSettings')?.addEventListener"), source.indexOf('  async function updateDoorScopes('));
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(request) {
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, disabled: false, textContent: '', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } }); return nodes.get(selector); };
  const links = [{ id: 'link-a', transcription: { enabled: false, model: 'tiny', language: 'en' } }, { id: 'link-b', transcription: { enabled: false, model: 'base', language: 'de' } }];
  node('#desktopBridgeLink').value = 'link-a';
  const ui = {};
  vm.runInNewContext(`let speechDraftLink='', speechDirty=false, speechSaving=false; ${render} ${bindings}; ui.render=renderSpeechSettings;`, {
    ui, document: { querySelector: node }, request, latestState: { agentLinks: links }, connectedLinks: state => state.agentLinks, encodeURIComponent
  });
  ui.render(links[0]);
  const edit = (id, value) => { node(id).value = value; node('#agentSpeechSettings').listeners.input(); };
  const save = () => node('#agentSpeechSave').listeners.click();
  return { node, links, edit, save, render: ui.render };
}

test('speech settings stay off by default and no-selection controls are disabled', () => {
  const f = fixture(); assert.equal(f.node('#agentSpeechEnabled').checked, false);
  assert.match(f.node('#agentSpeechStatus').textContent, /Microphone permission alone/);
  f.render(null); assert.equal(f.node('#agentSpeechSave').disabled, true);
  f.render({ id: 'private', transcription: { enabled: true, memoryOnly: true } });
  assert.match(f.node('#agentSpeechStatus').textContent, /Blocked/);
});

test('save binds the original Link and cannot overwrite another selection or its draft', async () => {
  const pending = deferred(), calls = [];
  const f = fixture((path, options) => { calls.push({path, body: JSON.parse(options.body)}); return pending.promise; });
  f.edit('#agentSpeechLanguage', 'fr'); f.render(f.links[0]); assert.equal(f.node('#agentSpeechLanguage').value, 'fr');
  const done = f.save(); await tick(); assert.equal(f.node('#agentSpeechSave').disabled, true);
  f.node('#desktopBridgeLink').value = 'link-b'; f.render(f.links[1]); f.edit('#agentSpeechLanguage','it');
  pending.resolve({ connection: { id: 'link-a' }, transcription: { ...f.links[0].transcription, language: 'fr' } }); await done;
  assert.equal(calls[0].path, '/api/agent-links/link-a/transcription'); assert.equal(calls[0].body.approved, undefined);
  assert.equal(f.links[0].transcription.language, 'fr'); assert.equal(f.links[1].transcription.language, 'de');
  assert.equal(f.node('#agentSpeechLanguage').value, 'it'); assert.equal(f.node('#agentSpeechSave').disabled, false);
});

test('denial and mismatched response retain the draft and feedback without retrying', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Object.assign(new Error('Approval'), { body: { approvalRequired: true } }); });
  f.edit('#agentSpeechLanguage', 'fr'); await f.save();
  assert.equal(calls, 1); assert.match(f.node('#agentSpeechStatus').textContent, /draft is retained/);
  assert.equal(f.node('#agentSpeechLanguage').value, 'fr'); assert.equal(f.links[0].transcription.language, 'en');
  const other = fixture(async () => ({ connection: { id: 'link-b' }, transcription: { language: 'es' } }));
  other.edit('#agentSpeechLanguage', 'fr'); await other.save();
  assert.match(other.node('#agentSpeechStatus').textContent, /did not match/);
  assert.equal(other.links[0].transcription.language, 'en'); assert.equal(other.node('#agentSpeechLanguage').value, 'fr');
});

test('speech configuration catalog uses the existing owner route without implied capture or grants', () => {
  const action = agentInterfaceManifest().actions.configureLocalTranscription;
  assert.equal(action.ownerOnly, true); assert.equal(action.policyCapability, 'write_workspace');
  assert.equal(action.pathTemplate, '/api/agent-links/{linkId}/transcription');
  assert.match(action.note, /Does not capture audio or grant device access/);
  assert.match(action.note, /Signed Links cannot/);
});
