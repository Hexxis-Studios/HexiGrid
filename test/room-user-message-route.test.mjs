import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('separate owner save route saves selected responders without reply-route variables', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  const userMessageMatch ='), source.indexOf('  const messageMatch ='));
  const room = {id:'qa', agentIds:['old'], messages:[]};
  const context = vm.createContext({pathname:'/api/rooms/qa/messages/user', method:'POST', req:{}, res:{},
    findRoom:()=>room, activeRoomTurns:new Map(), ongoingRoomReply:()=>false, readBody:async()=>({content:'Harmless QA',agentIds:['one','two']}),
    findAgent:()=>true, cleanString:value=>String(value ?? ''), id:()=> 'saved-user', now:()=> '2026-09-30',
    MAX_MESSAGES_PER_ROOM:100, addActivity(){}, saveState:async()=>{}, json:(_res,status,body)=>({status,body})});
  const result = await vm.runInContext(`(async()=>{${block}})()`,context);
  assert.equal(result.status,200);
  assert.deepEqual(Array.from(room.agentIds),['one','two']);
  assert.equal(room.messages[0].content,'Harmless QA');
  // A reply started through another path must block owner saves before changing responders or history.
  context.ongoingRoomReply = () => true;
  context.readBody = async () => { throw new Error('Busy room must reject before reading a write body.'); };
  const busy = await vm.runInContext(`(async()=>{${block}})()`, context);
  assert.equal(busy.status, 409);
  assert.deepEqual(Array.from(room.agentIds), ['one', 'two']);
  assert.equal(room.messages.length, 1);
  const replyBlock = source.slice(source.indexOf('  const messageMatch ='),source.indexOf('  const roomStopMatch ='));
  assert.match(replyBlock,/if \(includeUserMessage\) room\.agentIds = selectedIds;/);
});
