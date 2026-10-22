import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {ongoingRoomReply} from '../lib/room-continuation.mjs';
test('actual continuation route durably accepts once and refuses a competing turn or browser model',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('  const continuationMatch ='),source.indexOf('  const userMessageMatch ='));
  const room={id:'qa',agentIds:['local'],messages:[]};let body={content:'Harmless QA',agentIds:['local','local'],requestId:'request'},saved=0,kicks=0,browser=false;
  const context=vm.createContext({pathname:'/api/rooms/qa/turns',method:'POST',req:{},res:{},findRoom:()=>room,readBody:async()=>body,cleanString:value=>String(value||''),findAgent:id=>id==='local'?{id,transport:'local-opencode'}:null,
    ongoingRoomReply,activeRoomTurns:new Map(),allowedModel:()=>({browser}),id:()=>`owner-${saved}`,now:()=>new Date().toISOString(),MAX_MESSAGES_PER_ROOM:100,
    saveState:async()=>{saved++;assert.equal(room.replyChain.ownerMessageId,room.messages.at(-1).id);},roomEvents:{publish(){}},roomContinuations:{kick(){assert.equal(saved,1);kicks++;}},json:(_res,status,result)=>({status,result})});
  const run=()=>vm.runInContext(`(async()=>{${block}})()`,context);
  await run();assert.equal(saved,1);assert.equal(kicks,1);assert.equal(room.messages.length,1);assert.equal(room.replyChain.agentIds.length,1);
  assert.equal((await run()).result.duplicate,true);assert.equal(kicks,1);
  body={...body,requestId:'competing'};assert.equal((await run()).status,409);assert.equal(saved,1);
  room.replyChain.status='completed';browser=true;assert.equal((await run()).status,400);assert.equal(saved,1);
});
