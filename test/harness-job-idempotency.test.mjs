import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {retainedHarnessJobs} from '../lib/harness-job-history.mjs';
const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const execution=source.slice(source.indexOf('async function startHarnessJob('),source.indexOf('\nfunction cancelHarnessJob('));
function fixture(){
 const a={id:'agent-a',name:'A',model:'local-a'},b={id:'agent-b',name:'B',model:'local-b'};const profiles=new Map([[a.id,a],[b.id,b]]);let sequence=0;const calls=[];
 const ctx={AbortController,Date,retainedHarnessJobs,state:{agentLinks:[]},harnessJobs:new Map(),cleanString:(v,f='')=>typeof v==='string'&&v.trim()?v.trim():f,
 findAgent:id=>profiles.get(id),assertAgentActivity(){},connectorPolicy:()=>null,allowedModel:model=>({id:model}),id:()=>`harness-job-${++sequence}`,now:()=>new Date().toISOString(),
 pruneHarnessJobs(){},saveHarnessJobs:async()=>{},localProfileReply:async agent=>{calls.push(agent.id);return `Result for ${agent.id}`;},addReceipt(){},addActivity(){},saveState:async()=>{}};
 vm.runInNewContext(execution,ctx);return{a,b,ctx,calls,start:agent=>ctx.startHarnessJob({agent,prompt:'Harmless synthetic request',clientJobId:'same-client-key'})};
}
test('owner harness idempotency is bound to the selected agent, not a global client key',async()=>{
 const qa=fixture();const first=await qa.start(qa.a);const second=await qa.start(qa.b);await new Promise(setImmediate);
 assert.notEqual(first.id,second.id);assert.equal(first.agentId,qa.a.id);assert.equal(second.agentId,qa.b.id);assert.equal(first.output,'Result for agent-a');assert.equal(second.output,'Result for agent-b');assert.deepEqual(qa.calls,['agent-a','agent-b']);
 assert.equal((await qa.start(qa.a)).id,first.id);assert.equal((await qa.start(qa.b)).id,second.id);assert.equal(qa.calls.length,2);
});
test('a pending job from another agent cannot replace the requested agent job',async()=>{
 const qa=fixture();let release;qa.ctx.localProfileReply=async agent=>{qa.calls.push(agent.id);if(agent.id===qa.a.id)await new Promise(r=>release=r);return agent.id;};
 const pending=await qa.start(qa.a);assert.equal(pending.status,'running');const other=await qa.start(qa.b);await new Promise(setImmediate);
 assert.notEqual(other.id,pending.id);assert.equal(other.status,'completed');assert.equal(other.output,qa.b.id);assert.equal((await qa.start(qa.a)).id,pending.id);assert.equal(qa.calls.length,2);release();await new Promise(setImmediate);assert.equal(pending.output,qa.a.id);
});

test('persistence failure rejects a new job before any model dispatch',async()=>{
 const qa=fixture();qa.ctx.saveHarnessJobs=async()=>{throw new Error('Synthetic disk failure');};
 await assert.rejects(()=>qa.start(qa.a),/Synthetic disk failure/);assert.equal(qa.calls.length,0);assert.equal(qa.ctx.harnessJobs.size,0);
});
test('owner cancellation at the persistence boundary prevents dispatch',async()=>{
 const qa=fixture();let saves=0;qa.ctx.saveHarnessJobs=async()=>{if(++saves===2){const job=[...qa.ctx.harnessJobs.values()][0];job.cancellationRequested=true;job.controller.abort();}};
 const job=await qa.start(qa.a);await new Promise(setImmediate);assert.equal(job.status,'cancelled');assert.equal(qa.calls.length,0);
});

test('uncertain terminal attempts return retained standing without replaying possible effects',async()=>{
 for(const status of ['failed','cancelled','interrupted']){
  const qa=fixture();const first=await qa.start(qa.a);await new Promise(setImmediate);
  first.status=status;first.error='Synthetic terminal standing';first.output='';
  assert.equal(await qa.start(qa.a),first);assert.equal(qa.calls.length,1);
  assert.equal(first.status,status);
  const explicit=await qa.ctx.startHarnessJob({agent:qa.a,prompt:'Reviewed new attempt',clientJobId:'new-explicit-key'});
  await new Promise(setImmediate);assert.notEqual(explicit.id,first.id);assert.equal(qa.calls.length,2);
 }
});

test('expired records are pruned before retry lookup rather than revived',async()=>{
 const qa=fixture();const first=await qa.start(qa.a);await new Promise(setImmediate);
 qa.ctx.pruneHarnessJobs=()=>qa.ctx.harnessJobs.delete(first.id);
 const next=await qa.start(qa.a);await new Promise(setImmediate);
 assert.notEqual(next.id,first.id);assert.equal(qa.calls.length,2);
});
