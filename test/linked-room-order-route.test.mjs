import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createLinkedRoomWaiters} from '../lib/linked-room-wait.mjs';
import {queueLinkedRoomTurn,acceptLinkedRoomReply} from '../lib/linked-room-chat.mjs';
import {ongoingRoomReply} from '../lib/room-continuation.mjs';

test('actual multi-responder message handler includes the signed external reply before local generation',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('  const messageMatch ='),source.indexOf('  const roomStopMatch ='));
  const agents=[{id:'paired',name:'External',transport:'agent-link'},{id:'local',name:'Local',transport:'local-opencode'}];
  const room={id:'qa',agentIds:agents.map(item=>item.id),messages:[{id:'owner',role:'user',author:'You',content:'Harmless QA'}]};
  const connection={id:'link',agentId:'paired',status:'connected',capabilities:['messages'],events:[],eventSequence:0};
  const coordinator=createLinkedRoomWaiters();let saved,localCalls=0;const queued=new Promise(resolve=>{saved=resolve;});
  const context=vm.createContext({pathname:'/api/rooms/qa/messages',method:'POST',req:{},res:new EventEmitter(),AbortController,
    findRoom:()=>room,findAgent:id=>agents.find(item=>item.id===id),readBody:async()=>({agentIds:['paired','local','local'],includeUserMessage:false,requestId:'request'}),
    cleanString:value=>String(value||''),activeRoomTurns:new Map(),ongoingRoomReply,state:{agentLinks:[connection]},MAX_MESSAGES_PER_ROOM:100,
    id:()=>`local-${localCalls}`,now:()=>new Date().toISOString(),queueLinkedRoomTurn,connectorPolicy:()=>null,
    linkedRoomWaiters:coordinator,roomEvents:{publish(){}},addReceipt(){},addActivity(){},saveState:async()=>{saved();},
    respondForAgent:async(_agent,recent)=>{localCalls++;assert.match(recent,/External: Actual signed context/);return {ok:true,content:'Local answer'};},
    json:(_res,status,body)=>({status,body})});
  const responding=vm.runInContext(`(async()=>{${block}})()`,context);await queued;assert.equal(localCalls,0);
  acceptLinkedRoomReply({rooms:[room],connection,agent:agents[0],body:{roomId:'qa',eventId:room.messages[1].linkedTurn.eventId,text:'Actual signed context'}});
  coordinator.changed();const result=await responding;assert.equal(result.status,200);assert.equal(localCalls,1);assert.equal(context.activeRoomTurns.size,0);
});

test('actual owner wait handler rechecks its session before releasing private room data',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('  const linkedReplyWaitMatch ='),source.indexOf('  const messageMatch ='));
  const room={id:'qa',agentIds:['paired'],messages:[{id:'pending',agentId:'paired',linkedTurn:{eventId:'event',requestId:'request',status:'completed'}},{id:'reply',inReplyTo:'pending',delivery:'signed-link'}]};
  for(const authenticated of [true,false]){
    const activeRoomTurns=new Map();
    const context=vm.createContext({pathname:'/api/rooms/qa/replies/event/wait',method:'GET',url:new URL('http://localhost/api/rooms/qa/replies/event/wait?requestId=request'),req:{},res:new EventEmitter(),AbortController,
      findRoom:()=>room,cleanString:value=>String(value||''),activeRoomTurns,linkedRoomWaiters:createLinkedRoomWaiters(),authStatus:()=>({configured:true,authenticated}),json:(_res,status,body)=>({status,body})});
    const result=await vm.runInContext(`(async()=>{${block}})()`,context);
    assert.equal(result.status,authenticated?200:403);assert.equal(Boolean(result.body.room),authenticated);assert.equal(activeRoomTurns.size,0);
  }
});
