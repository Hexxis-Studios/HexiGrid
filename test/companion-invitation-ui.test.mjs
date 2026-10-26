import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AGENT_LINK_CAPABILITIES } from '../lib/agent-link.mjs';
import { OWNER_AGENT_CAPABILITIES } from '../lib/owner-agent-access.mjs';

test('invitation sharing copies the supplied skill and resume instructions, not a bare single-use URL', async () => {
  const source = await fs.readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("async function createDesktopLinkInvitation"), source.indexOf('async function desktopBridgeOwnerAction'));
  const instructions = 'Fetch the included skill. Pair once and reuse the saved connection on later turns. Synthetic invitation.';
  const nodes = new Map(); let submit, copied, dialog, requested;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { checked: selector === '#desktopBridgeCamera', textContent: '', addEventListener: (_, fn) => { submit = fn; } });
    return nodes.get(selector);
  };
  const context = { desktopBridgePermissionsBusy: false, renderDesktopBridge() { button.disabled = false; }, document: { querySelector: node },
    approvedRequest: async (_, request) => { requested = JSON.parse(request.body); return { agentPrompt: instructions, companionInvitationUrl: 'https://example.test/one-use' }; },
    copyPlainText: async value => { copied = value; return true; }, modalRequest: async value => { dialog = value; } };
  vm.runInNewContext(source.slice(0, source.indexOf('const integrationSection')) + handler + "\nthis.submit = createDesktopLinkInvitation;", context);
  submit = context.submit;
  const button = {};
  await submit({ preventDefault() {}, currentTarget: { querySelector: () => button } });
  assert.equal(copied, instructions);
  assert.equal(dialog.fields[0].value, instructions);
  assert.equal(dialog.fields[0].readonly, true);
  assert.ok(requested.capabilities.includes('camera-view'));
  assert.equal(requested.capabilities.includes('desktop-view'), false);
  assert.equal(requested.capabilities.includes('desktop-control'), false);
  assert.equal(button.disabled, false);
});

test('one invitation can select every standard permission without granting owner trust or changing existing Links', async () => {
  const source = await fs.readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
  const fields = source.slice(0, source.indexOf('const integrationSection'));
  const handler = source.slice(source.indexOf('async function createDesktopLinkInvitation'), source.indexOf('async function desktopBridgeOwnerAction'));
  for (const checked of [true, false]) {
    const calls = [];
    const context = { desktopBridgePermissionsBusy: false, renderDesktopBridge() {},
      document: { querySelector: () => ({ checked, textContent: '' }) },
      approvedRequest: async (route, request) => { calls.push({ route, body: JSON.parse(request.body) }); return { agentPrompt: 'PUBLIC-QA-INSTRUCTIONS' }; },
      copyPlainText: async () => true, modalRequest: async () => {} };
    vm.runInNewContext(fields + handler + '\nthis.submit = createDesktopLinkInvitation;', context);
    await context.submit({ preventDefault() {}, currentTarget: { querySelector: () => ({}) } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, '/api/agent-links/invites');
    assert.deepEqual(calls[0].body.capabilities.sort(), checked
      ? AGENT_LINK_CAPABILITIES.filter(scope => !OWNER_AGENT_CAPABILITIES.includes(scope)).sort()
      : ['identity', 'messages', 'receipts', 'status']);
    assert.equal(calls[0].body.selfManagementEnabled, checked);
    assert.equal(calls[0].body.agentId, undefined);
  }
});

test('reconnect help identifies the exact existing Link and supplies its skill without issuing an invitation', async () => {
  const source = await fs.readFile(new URL('../public/agent-link.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('  async function copyReconnectInstructions('), source.indexOf('  function renderConnections()'));
  let copied, dialog; const calls = [];
  const context = { state: { data: {} }, window: { HexiGridViewRenderers: { currentAgentLinks: () => [{ id: 'link-exact-qa', identity: { name: 'QA', framework: 'custom' } }] } },
    api: async route => { calls.push(route); return { agentRelay: { running: true, url: 'https://example.test' } }; },
    copyPlainText: async text => { copied = text; }, modalRequest: async value => { dialog = value; } };
  vm.runInNewContext(`${helper}\nthis.copyHelp = copyReconnectInstructions;`, context);
  await context.copyHelp('link-exact-qa');
  assert.deepEqual(calls, ['/api/network']);
  assert.match(copied, /https:\/\/example.test\/agent-link\/skill/);
  assert.match(copied, /status --connection link-exact-qa/);
  assert.match(copied, /Do not create a new agent or reuse the spent invitation/);
  assert.equal(dialog.fields[0].value, copied);
});

test('replacement preserves profile and scopes, retains old history and never revokes before an invitation exists', async () => {
  const source=await fs.readFile(new URL('../public/agent-link.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('  async function replaceConnection('),source.indexOf('  function renderConnections()'));
  for(const scenario of ['success','cancel','create-failed','revoke-failed','grants-changed']){
    const calls=[],dialogs=[];let copied;
    const link={id:'link-exact-qa',agentId:'agent-existing-qa',authorizationStatus:'connected',selfManagementEnabled:true,capabilities:['messages','camera-view','microphone-listen','speaker-output'],identity:{name:'QA'}};
    const context={replacingConnection:false,state:{data:{agentLinks:[link,{id:'link-other',agentId:'agent-other',capabilities:['workspace-write']}] }},
      api:async()=>({connections:[scenario==='grants-changed'?{...link,capabilities:['messages','camera-view'],selfManagementEnabled:false}:link]}),
      modalRequest:async value=>{dialogs.push(value);return scenario==='cancel'?null:[];},
      approvedRequest:async(route,request)=>{calls.push({route,body:JSON.parse(request.body),method:request.method});if(route==='/api/agent-links/invites'){if(scenario==='create-failed')throw Error('Create failed');return{agentPrompt:'PUBLIC-DISPOSABLE-QA-INSTRUCTIONS'};}if(scenario==='revoke-failed')throw Error('Revoke failed');return{};},
      copyPlainText:async text=>{copied=text;return true;},feedback(){},refreshLinks:async()=>{}
    };
    vm.runInNewContext(helper+'\nthis.replace=replaceConnection;',context);
    if(scenario==='create-failed')await assert.rejects(context.replace(link.id),/Create failed/);else await context.replace(link.id);
    assert.equal(context.replacingConnection,false);
    if(scenario==='cancel'){assert.equal(calls.length,0);continue;}
    assert.equal(calls[0].body.agentId,link.agentId);assert.deepEqual(calls[0].body.capabilities,scenario==='grants-changed'?['messages','camera-view']:link.capabilities);assert.equal(calls[0].body.selfManagementEnabled,scenario!=='grants-changed');
    if(scenario==='create-failed'){assert.equal(calls.length,1);assert.equal(copied,undefined);continue;}
    assert.equal(calls[1].route,'/api/agent-links/link-exact-qa');assert.equal(calls[1].method,'DELETE');assert.equal(calls[1].body.purge,false);
    assert.equal(copied,'PUBLIC-DISPOSABLE-QA-INSTRUCTIONS');assert.equal(dialogs[1].fields[0].value,copied);
    if(scenario==='revoke-failed')assert.match(dialogs[1].message,/could not be revoked/);
    assert.equal(calls.some(call=>call.route.includes('link-other')),false);
  }
});
