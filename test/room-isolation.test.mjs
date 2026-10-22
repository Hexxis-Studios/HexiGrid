import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomContinuations} from '../lib/room-continuation.mjs';
import {createLinkedRoomWaiters} from '../lib/linked-room-wait.mjs';
import {queueLinkedRoomTurn,acceptLinkedRoomReply} from '../lib/linked-room-chat.mjs';

function fixture() {
  const agents=[{id:'agent-a',name:'Agent A'},{id:'agent-b',name:'Agent B'}];
  const links=agents.map((agent,index)=>({id:`link-${index}`,agentId:agent.id,status:'connected',capabilities:['messages'],events:[],nextSequence:1}));
  const rooms=agents.map((agent,index)=>({id:`room-${index}`,agentIds:[agent.id],messages:[{id:`owner-${index}`,role:'user',author:'Owner',content:`Private ${agent.id} prompt`}],replyChain:{requestId:`request-${index}`,ownerMessageId:`owner-${index}`,agentIds:[agent.id],index:0,status:'ready'}}));
  const waits=agents.map(()=>createLinkedRoomWaiters()),turns=new Map(),receipts=[];
  const manager=createRoomContinuations({rooms:()=>rooms,save:async()=>{},publish(){},turns,
    findAgent:id=>agents.find(agent=>agent.id===id),isBrowser:()=>false,validate(){},
    queue:(room,agent,chain,transcript)=>{const index=agents.indexOf(agent);receipts.push({link:links[index].id,room:room.id});return queueLinkedRoomTurn({room,connection:links[index],agent,requestId:chain.requestId,ownerMessageId:chain.ownerMessageId,transcript});},
    wait:options=>waits[agents.findIndex(agent=>rooms.find(room=>room.id===options.room.id)?.agentIds.includes(agent.id))]?.["wait"](options),
    respond:async()=>({ok:true,content:'local'}),message:()=>({role:'agent',content:'local'})});
  return {agents,links,rooms,waits,manager,receipts};
}

async function queued(f,index) {
  f.manager.kick(f.rooms[index]);
  await new Promise(resolve=>setImmediate(resolve));
  return f.rooms[index].messages.find(message=>message.linkedTurn);
}

test('separately signed Links can queue and reply only in their disjoint member rooms',async()=>{
  const f=fixture();
  const pendingA=await queued(f,0),pendingB=await queued(f,1);
  assert.ok(pendingA && pendingB);
  assert.deepEqual(f.links.map(link=>link.events.length),[1,1]);
  for (const [i,other] of [[0,1],[1,0]]) {
    const before=f.rooms[other].messages.length,events=f.links[i].events.length,receiptCount=f.receipts.length;
    assert.throws(()=>queueLinkedRoomTurn({room:f.rooms[other],connection:f.links[i],agent:f.agents[i],requestId:'cross',ownerMessageId:f.rooms[other].messages[0].id,transcript:'must not leak'}),/not a current responder/);
    assert.throws(()=>acceptLinkedRoomReply({rooms:f.rooms,connection:f.links[i],agent:f.agents[i],body:{roomId:f.rooms[other].id,eventId:(other===0?pendingA:pendingB).linkedTurn.eventId,text:'cross-room reply'}}),/unavailable to this Link/);
    assert.equal(f.rooms[other].messages.length,before);
    assert.equal(f.links[i].events.length,events);
    assert.equal(f.receipts.length,receiptCount);
  }
  for (const i of [0,1]) {
    const pending=i===0?pendingA:pendingB;
    acceptLinkedRoomReply({rooms:f.rooms,connection:f.links[i],agent:f.agents[i],body:{roomId:f.rooms[i].id,eventId:pending.linkedTurn.eventId,text:`reply-${i}`}});
    f.waits[i].changed();
  }
  await Promise.all(f.rooms.map(room=>f.manager.settled(room)));
  assert.deepEqual(f.rooms.map(room=>room.messages.some(message=>message.content==='reply-0'||message.content==='reply-1')),[true,true]);
  assert.deepEqual(f.receipts,[{link:'link-0',room:'room-0'},{link:'link-1',room:'room-1'}]);
});

test('removing one Link identity from its room blocks it while the other room continues',async()=>{
  const f=fixture();
  const pendingA=await queued(f,0),pendingB=await queued(f,1);
  f.rooms[0].agentIds=[];
  assert.throws(()=>acceptLinkedRoomReply({rooms:f.rooms,connection:f.links[0],agent:f.agents[0],body:{roomId:f.rooms[0].id,eventId:pendingA.linkedTurn.eventId,text:'removed'}}),/unavailable to this Link/);
  f.waits[0].changed();
  acceptLinkedRoomReply({rooms:f.rooms,connection:f.links[1],agent:f.agents[1],body:{roomId:f.rooms[1].id,eventId:pendingB.linkedTurn.eventId,text:'still works'}});
  f.waits[1].changed();
  await Promise.all(f.rooms.map(room=>f.manager.settled(room)));
  assert.equal(f.rooms[0].messages.some(message=>message.content==='removed'),false);
  assert.equal(f.rooms[0].replyChain.status,'blocked');
  assert.equal(f.rooms[1].messages.some(message=>message.content==='still works'),true);
  assert.equal(f.rooms[1].replyChain.status,'completed');
});
