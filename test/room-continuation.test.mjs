import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomContinuations} from '../lib/room-continuation.mjs';
import {createLinkedRoomWaiters} from '../lib/linked-room-wait.mjs';
import {queueLinkedRoomTurn,acceptLinkedRoomReply} from '../lib/linked-room-chat.mjs';

function fixture(saved) {
  const agents=[{id:'external',name:'External'},{id:'local',name:'Local'}];
  const room=saved || {id:'room',agentIds:agents.map(item=>item.id),messages:[{id:'owner',role:'user',content:'Harmless QA'}],replyChain:{requestId:'request',ownerMessageId:'owner',agentIds:agents.map(item=>item.id),index:0,status:'ready'}};
  const connection={id:'link',agentId:'external',status:'connected',capabilities:['messages'],events:[],nextSequence:1};
  const waits=createLinkedRoomWaiters(),turns=new Map(),snapshots=[],calls=[];
  let blocked=false, failSave=false;
  const manager=createRoomContinuations({rooms:()=>[room],save:async()=>{if(failSave)throw Error('Disk unavailable');snapshots.push(structuredClone(room));},publish(){},turns,findAgent:id=>agents.find(item=>item.id===id),isBrowser:()=>false,
    validate(){if(blocked)throw Error('Policy changed');},queue:(room,agent,chain,transcript)=>agent.id==='external'?queueLinkedRoomTurn({room,agent,connection,requestId:chain.requestId,ownerMessageId:chain.ownerMessageId,transcript}):null,
    wait:options=>waits.wait(options),respond:async(_agent,context)=>{calls.push(context);return {ok:true,content:'Actual local reply'};},message:(agent,response)=>({role:'agent',agentId:agent.id,content:response.content})});
  return {room,connection,manager,waits,turns,snapshots,calls,agents,setBlocked(){blocked=true;},setFail(){failSave=true;}};
}
async function waiting(f) {f.manager.kick(f.room);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.room.replyChain.status,'waiting');}
function signed(f) {const pending=f.room.messages.find(item=>item.linkedTurn);acceptLinkedRoomReply({rooms:[f.room],connection:f.connection,agent:f.agents[0],body:{roomId:f.room.id,eventId:pending.linkedTurn.eventId,text:'Actual external reply'}});f.waits.changed();}

test('encrypted saved waiting turn resumes after host interruption without another event; actual signed reply precedes local call',async()=>{
  const first=fixture();await waiting(first);
  const saved=structuredClone(first.snapshots.at(-1));first.turns.get(first.room.id).controller.abort('shutdown');await first.manager.settled(first.room);
  const next=fixture(saved);await next.manager.recover();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(next.room.messages.filter(item=>item.linkedTurn).length,1);
  signed(next);await next.manager.settled(next.room);
  assert.equal(next.calls.length,1);assert.match(next.calls[0],/Actual external reply/);
  assert.equal(next.room.replyChain.status,'completed');
  assert.equal(next.snapshots.find(item=>item.replyChain.status==='running').messages.some(item=>item.content==='Actual local reply'),false,'intent saved before dispatch');
});
test('interrupted model intent is never automatically retried',async()=>{
  const f=fixture();f.room.replyChain.status='running';f.room.replyChain.index=1;
  await f.manager.recover();assert.equal(f.room.replyChain.status,'interrupted');assert.equal(f.calls.length,0);
});
test('Stop survives recovery and policy/removal/expiry prevent later dispatch',async()=>{
  for(const kind of ['stop','policy','removed','expired']) {
    const f=fixture();await waiting(f);
    if(kind==='stop'){await f.manager.stop(f.room);await f.manager.settled(f.room);await f.manager.recover();}
    else {if(kind==='policy')f.setBlocked();if(kind==='removed')f.room.agentIds=['external'];if(kind==='expired')f.room.messages.find(item=>item.linkedTurn).linkedTurn.expiresAt=new Date(0).toISOString();
      kind==='expired'?f.waits.changed():signed(f);await f.manager.settled(f.room);}
    assert.equal(f.calls.length,0,kind);assert.equal(f.room.replyChain.status,kind==='stop'?'cancelled':'blocked');
  }
});
test('failed durable intent prevents model dispatch',async()=>{
  const f=fixture();f.room.replyChain.index=1;f.setFail();await f.manager.kick(f.room);assert.equal(f.calls.length,0);
});
test('Stop during the pre-dispatch save never starts the model',async()=>{
  const room={id:'room',agentIds:['local'],messages:[{id:'owner',role:'user'}],replyChain:{requestId:'request',ownerMessageId:'owner',agentIds:['local'],index:0,status:'ready'}};
  const agent={id:'local'};let release,calls=0,saves=0;const saving=new Promise(resolve=>{release=resolve;});
  const manager=createRoomContinuations({rooms:()=>[room],save:async()=>{if(++saves===1)await saving;},publish(){},turns:new Map(),findAgent:()=>agent,isBrowser:()=>false,validate(){},queue:()=>null,wait(){},respond:async()=>{calls++;return {ok:true};},message:()=>({})});
  const work=manager.kick(room);await manager.stop(room);release();await work;assert.equal(calls,0);assert.equal(room.replyChain.status,'cancelled');
});
