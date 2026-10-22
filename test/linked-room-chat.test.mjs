import test from 'node:test';
import assert from 'node:assert/strict';
import { queueLinkedRoomTurn, acceptLinkedRoomReply } from '../lib/linked-room-chat.mjs';
function fixture() {
 const agent={id:'agent',name:'QA'};
 const connection={id:'link',agentId:'agent',status:'connected',capabilities:['messages'],events:[],nextSequence:1};
 const room={id:'room',name:'QA room',agentIds:['agent','second'],messages:[{id:'owner-message',role:'user',content:'QA'}]};
 const queued=queueLinkedRoomTurn({room,connection,agent,requestId:'request',transcript:'You: QA',ownerMessageId:'owner-message'});
 return {room,connection,agent,queued,body:{roomId:'room',eventId:queued.linkedTurn.eventId,text:'QA reply'}};
}
test('queued room context and signed reply retain exact identity and idempotency',()=>{
 const f=fixture(); assert.equal(f.connection.events[0].type,'room-message'); assert.equal(f.connection.events[0].metadata.roomId,'room');
 assert.equal(queueLinkedRoomTurn({...f,requestId:'retry',transcript:'You: QA',ownerMessageId:'owner-message'}).id,f.queued.id);
 assert.equal(f.connection.events.length,1);
 const result=acceptLinkedRoomReply({...f,rooms:[f.room]}); assert.equal(result.message.delivery,'signed-link'); assert.equal(f.queued.linkedTurn.status,'completed');
 assert.equal(acceptLinkedRoomReply({...f,rooms:[f.room]}).duplicate,true);
 assert.throws(()=>acceptLinkedRoomReply({...f,rooms:[f.room],body:{...f.body,text:'changed'}}),/different reply/);
});
test('foreign Link or room cannot use another pending event',()=>{
 const f=fixture(); assert.throws(()=>acceptLinkedRoomReply({...f,rooms:[f.room],connection:{...f.connection,id:'other'}}),/unavailable/);
 assert.throws(()=>acceptLinkedRoomReply({...f,rooms:[f.room],body:{...f.body,roomId:'other'}}),/unavailable/);
 assert.equal(f.room.messages.length,2);
});
test('revocation, membership removal, archive and expiry reject late replies',()=>{
 for(const kind of ['revoked','removed','archived','expired','cancelled']) {const f=fixture();
 if(kind==='revoked') f.connection.status='revoked'; if(kind==='removed') f.room.agentIds=[]; if(kind==='archived')f.room.archived=true;
 if(kind==='expired')f.queued.linkedTurn.expiresAt='2000-01-01T00:00:00.000Z';
 if(kind==='cancelled')f.queued.linkedTurn.status='cancelled';
 assert.throws(()=>acceptLinkedRoomReply({...f,rooms:[f.room]}),/cannot reply|unavailable|expired/); assert.equal(f.room.messages.length,2);
 }
});
test('invalid text never changes a pending request',()=>{
 for(const text of ['', 'x'.repeat(50001)]) {const f=fixture();assert.throws(()=>acceptLinkedRoomReply({...f,rooms:[f.room],body:{...f.body,text}}),/non-empty/);assert.equal(f.queued.linkedTurn.status,'queued');}
});
