import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/workspace-ui.js', import.meta.url), 'utf8');
function fixture(api, confirm = async () => false) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: id === '#workspacePathInput' ? '/Welcome.md' : '', textContent: '', disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ document: { querySelector: $ }, api, userConfirm: confirm, notify() {}, state: { workspaceFolder: '/' }, encodeURIComponent, escapeHtml: String });
  vm.runInContext(source, ctx);
  ctx.$ = $; // app.js defines this after workspace-ui.js loads.
  vm.runInContext('loadWorkspace = async () => {}', ctx);
  return { ctx, $ };
}

test('cancel keeps unsaved file content and prevents the replacement request', async () => {
  let calls = 0;
  const { ctx, $ } = fixture(async () => { calls++; return { path: '/one', content: 'saved' }; });
  await ctx.openWorkspaceFile('/one');
  $('#workspaceEditor').value = 'unsaved';
  $('#workspaceEditor').listeners.input();
  assert.equal($('#workspaceDraftStatus').textContent, 'Unsaved changes');
  await ctx.openWorkspaceFile('/two');
  assert.equal(calls, 1);
  assert.equal($('#workspaceEditor').value, 'unsaved');
  assert.equal($('#workspacePathInput').value, '/one');
});

test('save is enabled only for a changed draft and stays disabled during a disk conflict', async () => {
  const { ctx, $ } = fixture(async () => ({ path: '/one', content: 'saved', sha256: 'first' }));
  const save = $('[data-action="save-workspace-file"]');
  save.disabled = true;
  ctx.renderWorkspaceDraftStatus();
  assert.equal(save.disabled, true);
  await ctx.openWorkspaceFile('/one');
  assert.equal(save.disabled, true);
  $('#workspaceEditor').value = 'edited';
  $('#workspaceEditor').listeners.input();
  assert.equal(save.disabled, false);
  vm.runInContext('workspaceSaveConflict = true; renderWorkspaceDraftStatus()', ctx);
  assert.equal(save.disabled, true);
});

test('a late file read cannot overwrite text typed while it is loading', async () => {
  let resolve;
  const { ctx, $ } = fixture(() => new Promise(done => { resolve = done; }));
  const pending = ctx.openWorkspaceFile('/one');
  $('#workspaceEditor').value = 'new draft';
  $('#workspaceEditor').listeners.input();
  resolve({ path: '/one', content: 'old response' });
  await pending;
  assert.equal($('#workspaceEditor').value, 'new draft');
});

test('confirmed replacement clears standing only after a successful read', async () => {
  const { ctx, $ } = fixture(async path => {
    if (path.includes('missing')) throw new Error('Unavailable');
    return { path: '/two', content: 'replacement' };
  }, async () => true);
  $('#workspaceEditor').value = 'keep on failure';
  await ctx.openWorkspaceFile('/missing');
  assert.equal($('#workspaceEditor').value, 'keep on failure');
  await ctx.openWorkspaceFile('/two');
  assert.equal($('#workspaceEditor').value, 'replacement');
  assert.equal($('#workspaceDraftStatus').textContent, 'No unsaved changes');
});

test('approval retry writes the exact requested draft and retains newer edits as unsaved', async () => {
  const writes = [];
  let $;
  const ui = fixture(async (path, options) => {
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) throw { body: { approvalRequired: true }, message: 'Approval required' };
    return { path: '/qa' };
  }, async () => { $('#workspaceEditor').value = 'newer'; return true; });
  $ = ui.$;
  $('#workspacePathInput').value = '/qa';
  $('#workspaceEditor').value = 'original';
  await ui.ctx.saveWorkspaceFile();
  assert.deepEqual(writes, [{ path: '/qa', content: 'original', createOnly:true, approved: false }, { path: '/qa', content: 'original', createOnly:true, approved: true }]);
  assert.equal($('#workspaceEditor').value, 'newer');
  assert.equal($('#workspaceDraftStatus').textContent, 'Unsaved changes');
});
test('stale save carries the opened digest, preserves the draft and clears conflict only on reload',async()=>{
  const writes=[];let current='first';const ui=fixture(async(path,options)=>{
    if(!options) return {path:'/qa',content:current,sha256:current};
    writes.push(JSON.parse(options.body));throw {body:{code:'workspace_file_changed'},message:'File changed'};
  },async()=>true);
  await ui.ctx.openWorkspaceFile('/qa');ui.$('#workspaceEditor').value='owner draft';current='agent edit';
  await ui.ctx.saveWorkspaceFile();assert.equal(writes[0].expectedSha256,'first');
  assert.equal(ui.$('#workspaceEditor').value,'owner draft');assert.match(ui.$('#workspaceDraftStatus').textContent,/draft is kept/);
  await ui.ctx.openWorkspaceFile('/qa');assert.equal(ui.$('#workspaceEditor').value,'agent edit');assert.equal(ui.$('#workspaceDraftStatus').textContent,'No unsaved changes');
});

test('a delayed save cannot replace the version of another opened file', async () => {
  let finishSave;
  const writes = [];
  const ui = fixture(async (path, options) => {
    if (!options) return path.includes('second') ? { path: '/second', content: 'second', sha256: 'second-hash' } : { path: '/first', content: 'first', sha256: 'first-hash' };
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) return new Promise(resolve => { finishSave = resolve; });
    return { path: '/second', sha256: 'second-updated' };
  }, async () => true);
  await ui.ctx.openWorkspaceFile('/first');
  ui.$('#workspaceEditor').value = 'saved first';
  const pending = ui.ctx.saveWorkspaceFile();
  await ui.ctx.openWorkspaceFile('/second');
  finishSave({ path: '/first', sha256: 'first-updated' });
  await pending;
  assert.equal(ui.$('#workspaceDraftStatus').textContent, 'No unsaved changes');
  ui.$('#workspaceEditor').value = 'saved second';
  await ui.ctx.saveWorkspaceFile();
  assert.equal(writes[1].expectedSha256, 'second-hash');
  assert.equal(writes[1].createOnly, undefined);
});

test('a delayed failed save cannot mark another opened file as conflicted', async () => {
  let failSave;
  const ui = fixture(async (path, options) => {
    if (!options) return { path: path.includes('second') ? '/second' : '/first', content: 'saved', sha256: 'hash' };
    return new Promise((_, reject) => { failSave = reject; });
  }, async () => true);
  await ui.ctx.openWorkspaceFile('/first');
  ui.$('#workspaceEditor').value = 'edited';
  const pending = ui.ctx.saveWorkspaceFile();
  await ui.ctx.openWorkspaceFile('/second');
  failSave({ body: { code: 'workspace_file_changed' }, message: 'First file changed' });
  await pending;
  assert.equal(ui.$('#workspaceDraftStatus').textContent, 'No unsaved changes');
});

test('a late save receipt cannot replace a newer read of the same file', async () => {
  let finishSave, reads = 0;
  const writes = [];
  const ui = fixture(async (path, options) => {
    if (!options) { reads++; return { path: '/same', content: `read-${reads}`, sha256: `hash-${reads}` }; }
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) return new Promise(resolve => { finishSave = resolve; });
    return { path: '/same', sha256: 'latest' };
  }, async () => true);
  await ui.ctx.openWorkspaceFile('/same');
  ui.$('#workspaceEditor').value = 'first save';
  const pending = ui.ctx.saveWorkspaceFile();
  await ui.ctx.openWorkspaceFile('/same');
  finishSave({ path: '/same', sha256: 'old-receipt' });
  await pending;
  assert.equal(ui.$('#workspaceDraftStatus').textContent, 'No unsaved changes');
  ui.$('#workspaceEditor').value = 'next edit';
  await ui.ctx.saveWorkspaceFile();
  assert.equal(writes[1].expectedSha256, 'hash-2');
});
