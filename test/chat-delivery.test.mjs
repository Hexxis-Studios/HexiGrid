import test from 'node:test';
import assert from 'node:assert/strict';
import { unavailableChatMessage } from '../lib/chat-delivery.mjs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('paired external chat denial distinguishes Link delivery from local models', () => {
  const message = unavailableChatMessage({ name: 'Muse QA', transport: 'agent-link' });
  assert.match(message, /paired external Link/);
  assert.match(message, /No message was delivered/);
  assert.match(message, /Open a chat room/);
  assert.doesNotMatch(message, /iLands|BYOA|Runner/);
});

test('unsupported transports get provider-neutral recovery guidance', () => {
  assert.match(unavailableChatMessage({ name: 'QA', transport: 'unknown' }), /supported chat connector/);
  assert.doesNotMatch(unavailableChatMessage({}), /undefined|iLands/);
});

test('legacy paired profile replies expose local identity before and after sending', async () => {
  const nodes = new Map();
  const node = key => { if (!nodes.has(key)) nodes.set(key, { value:'', textContent:'', innerHTML:'' }); return nodes.get(key); };
  const person = { id:'paired', name:'Muse QA', transport:'ilands-link' };
  const room = { id:'room', name:'QA', agentIds:['paired'], messages:[{ role:'agent', agentId:'paired', author:'Muse QA', content:'Local fixture', delivery:'local-only' }] };
  const context = vm.createContext({ $, state:{ data:{rooms:[room],agents:[person]} }, activeRoom:()=>room,
    agent:()=>person, document:{querySelector:node}, escapeHtml:String, agentListLabel:item=>item.name,
    colorTile:()=>'', initials:()=>'', timeAgo:()=>'' });
  function $(key) { return node(key); }
  vm.runInContext(await readFile(new URL('../public/chat-ui.js',import.meta.url),'utf8'),context);
  context.renderRooms();
  assert.match(node('#composerHint').textContent,/receive this conversation through their Link/);
  assert.match(node('#messageList').innerHTML,/LOCAL PROFILE REPLY · NOT EXTERNAL AGENT/);
});
