import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinkedRoomWaiters} from '../lib/linked-room-wait.mjs';

function fixture() {
  const pending = {id:'pending',agentId:'exampleagent',linkedTurn:{eventId:'event',requestId:'request',status:'queued',expiresAt:new Date(Date.now()+30000).toISOString()}};
  const room = {id:'room',agentIds:['exampleagent','local'],messages:[pending]};
  return {room,pending};
}
function reply(room,pending) {pending.linkedTurn.status='completed';room.messages.push({id:'reply',inReplyTo:pending.id,delivery:'signed-link',content:'Actual external context'});}

test('notification wakes only after the exact signed reply, including fast delivery',async()=>{
  const coordinator=createLinkedRoomWaiters(),{room,pending}=fixture();let settled=false;
  const waiting=coordinator.wait({room,eventId:'event',requestId:'request'}).then(result=>{settled=true;return result;});
  coordinator.changed();await Promise.resolve();assert.equal(settled,false);
  room.messages.push({id:'other',delivery:'signed-link',inReplyTo:'another-pending'});coordinator.changed();await Promise.resolve();assert.equal(settled,false);
  reply(room,pending);coordinator.changed();assert.equal((await waiting).message.content,'Actual external context');
  assert.equal((await coordinator.wait({room,eventId:'event',requestId:'request'})).message.id,'reply');
});

test('cancel, member removal, archive and wrong request never release a later responder',async()=>{
  for(const change of ['cancel','remove','archive','wrong']){
    const coordinator=createLinkedRoomWaiters(),{room,pending}=fixture();
    const waiting=coordinator.wait({room,eventId:'event',requestId:change==='wrong'?'other':'request'});
    const rejected=assert.rejects(waiting);
    if(change==='cancel')pending.linkedTurn.status='cancelled';
    if(change==='remove')room.agentIds=[];
    if(change==='archive')room.archived=true;
    coordinator.changed();await rejected;
  }
});

test('owner abort ends the wait without deleting the queued message',async()=>{
  const coordinator=createLinkedRoomWaiters(),{room,pending}=fixture(),controller=new AbortController();
  const waiting=coordinator.wait({room,eventId:'event',requestId:'request',signal:controller.signal});
  const rejected=assert.rejects(waiting,/wait stopped/);controller.abort();await rejected;
  assert.equal(pending.linkedTurn.status,'queued');assert.equal(room.messages.length,1);
});

test('expired request rejects immediately and cannot become context through late delivery',async()=>{
  const coordinator=createLinkedRoomWaiters(),{room,pending}=fixture();pending.linkedTurn.expiresAt=new Date(Date.now()-1).toISOString();
  await assert.rejects(coordinator.wait({room,eventId:'event',requestId:'request'}),/expired/);
});
