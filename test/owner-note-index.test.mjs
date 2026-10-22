import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerMemory, reviseOwnerMemory, inactiveOwnerMemoryIndex, recallOwnerMemories } from '../lib/owner-memory.mjs';
const note = (agentId, content) => createOwnerMemory({content,category:'QA',importance:3}, {agentId,source:'owner',at:'2026-10-04T10:00:00Z'});
test('explicit inactive owner index finds retained text without returning text or deep history', () => {
 const active=note('one','current private text'), old=note('one','hidden blue workspace');
 const retired=reviseOwnerMemory(old,{status:'historical',evidence_excerpt:'private source'}, {by:'owner',why:'private reason',at:'2026-10-04T11:00:00Z'});
 const foreign=reviseOwnerMemory(note('two','hidden blue workspace'),{status:'historical'},{by:'owner',why:'foreign',at:'2026-10-04T11:00:00Z'});
 const data=[active,retired,foreign];
 const result=inactiveOwnerMemoryIndex(data,{agentId:'one',query:'BLUE'});
 assert.equal(result.total,1); assert.equal(result.memories[0].id,old.id); assert.equal(result.memories[0].revision_count,1);
 assert.equal(result.memories[0].inactiveIndex,true); assert.equal(result.memories[0].status,'historical');
 assert.doesNotMatch(JSON.stringify(result),/hidden blue|private source|private reason|foreign/);
 for(const key of ['content','revisions','evidence_excerpt','source','verification']) assert.equal(Object.hasOwn(result.memories[0],key),false);
 assert.deepEqual(recallOwnerMemories(data,{agentId:'one'}).map(item=>item.id),[active.id]);
 assert.equal(inactiveOwnerMemoryIndex(data,{agentId:'one',query:'missing'}).total,0);
});
test('inactive index is bounded, explicit about omissions, and validates selection',()=>{
 const records=Array.from({length:102},(_,i)=>reviseOwnerMemory(note('one',`old${i}`),{status:'rejected'},{by:'owner',why:'QA',at:'2026-10-04T11:00:00Z'}));
 const result=inactiveOwnerMemoryIndex(records,{agentId:'one'});
 assert.equal(result.total,102); assert.equal(result.memories.length,100); assert.equal(result.truncated,true);
 assert.throws(()=>inactiveOwnerMemoryIndex(records,{agentId:'one',query:'x'.repeat(257)}),/256/);
 assert.throws(()=>inactiveOwnerMemoryIndex(records,{agentId:'one',limit:101}),/100/);
 assert.equal(inactiveOwnerMemoryIndex(records,{agentId:'foreign'}).total,0);
});
