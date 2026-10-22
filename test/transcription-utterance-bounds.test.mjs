import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTranscriber } from '../lib/local-transcription.mjs';

function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const transcriber=new LocalTranscriber({finalDelayMs:100}), jobs=[],events=[];
  transcriber.transcribe=async chunks=>{jobs.push(chunks.map(c=>c.sequence));return 'Synthetic full turn.';};
  const connection={id:'bounded',transcription:{enabled:true}};
  const send=(sequence, options={})=>transcriber.enqueue(connection,{sequence,speechActive:true,data:'eA==',durationMs:1000,...options},event=>events.push(event));
  const flush=async()=>{t.mock.timers.tick(100);await transcriber.buffers.get(connection.id).chain;};
  return{transcriber,connection,jobs,events,send,flush};
}

test('ordinary long spoken turn retains its beginning instead of a twelve-segment tail',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=30;sequence++)assert.equal(f.send(sequence).queued,true);
  await f.flush();const final=f.events.filter(e=>e.type==='speech.transcript.final');assert.equal(final.length,1);
  assert.deepEqual(f.jobs.at(-1),Array.from({length:30},(_,i)=>i+1));f.transcriber.clear(f.connection.id);
});

test('oversized turn reports once, emits no truncated final, and resumes only after a pause',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=120;sequence++)f.send(sequence);
  assert.equal(f.send(121).reason,'utterance-limit');for(let sequence=122;sequence<=130;sequence++)assert.equal(f.send(sequence).queued,false);
  assert.equal(f.transcriber.buffers.get(f.connection.id).chunks.length,0);
  assert.equal(f.events.filter(e=>e.type==='speech.transcription.error').length,1);
  await f.flush();assert.equal(f.events.filter(e=>e.type==='speech.transcript.final').length,0);
  assert.equal(f.send(131,{speechActive:false}).reason,'silence');f.send(132);await f.flush();
  assert.deepEqual(f.jobs.at(-1),[132]);assert.equal(f.events.filter(e=>e.type==='speech.transcript.final').length,1);
  assert.match(f.connection.transcription.lastError,/not recognized in full/);f.transcriber.clear(f.connection.id);
});

test('independent byte and duration caps reject a whole turn without retaining an unbounded buffer',async t=>{
  const f=fixture(t),payload=Buffer.alloc(600*1024).toString('base64');let result;
  for(let i=0;i<15;i++)result=f.send(i,{data:payload});
  assert.equal(result.reason,'utterance-limit');assert.equal(f.transcriber.buffers.get(f.connection.id).chunks.length,0);
  f.transcriber.configure(f.connection,{enabled:true});
  for(let i=0;i<49;i++)result=f.send(i,{durationMs:2500});
  assert.equal(result.reason,'utterance-limit');assert.equal(f.transcriber.buffers.get(f.connection.id).chunks.length,0);
  f.transcriber.clear(f.connection.id);
});
