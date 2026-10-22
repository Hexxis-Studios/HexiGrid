import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTranscriber } from '../lib/local-transcription.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const transcriber = new LocalTranscriber(), entry = { controller: new AbortController(), chain: Promise.resolve(), chunks: [] };
  const connection = { id: 'synthetic', transcription: { enabled: true, model: 'tiny', language: 'en' } };
  transcriber.buffers.set(connection.id, entry);
  const events = [], jobs = [], first = deferred();
  transcriber.transcribe = async (chunks, settings, {signal}) => {
    jobs.push({sequence:chunks[0].sequence,settings,signal});
    return jobs.length === 1 ? first.promise : `Turn ${chunks[0].sequence}.`;
  };
  const submit = (sequence, final = false) => transcriber.schedule(entry, connection, [{sequence}], final, event=>events.push(event));
  return {transcriber,entry,connection,events,jobs,first,submit};
}

test('completed turn cancels obsolete active preview and skips coalesced preview backlog', async () => {
  const f = fixture(); f.submit(1);
  for (let sequence=2;sequence<=100;sequence++) f.submit(sequence);
  assert.equal(f.jobs.length,1); assert.equal(f.entry.pendingPartial.chunks[0].sequence,100);
  f.submit(101,true); assert.equal(f.jobs[0].signal.aborted,true); assert.equal(f.entry.pendingPartial,null);
  f.first.resolve('Late superseded preview.'); await f.entry.chain;
  assert.deepEqual(f.jobs.map(j=>j.sequence),[1,101]); assert.equal(f.events.length,1);
  assert.equal(f.events[0].type,'speech.transcript.final'); assert.equal(f.events[0].text,'Turn 101.');
});

test('completed turns retain ordering with bounded overload and explicit missing-turn feedback', async () => {
  const f = fixture(); f.submit(1,true); f.submit(2,true); f.submit(3,true); f.submit(4,true);
  assert.equal(f.entry.pendingFinals.length,2); assert.equal(f.jobs[0].signal.aborted,false);
  assert.equal(f.events.length,1); assert.equal(f.events[0].type,'speech.transcription.error');
  assert.equal(f.events[0].metadata.reason,'recognition-backlog'); assert.match(f.connection.transcription.lastError,/not recognized/);
  f.first.resolve('First.'); await f.entry.chain;
  assert.deepEqual(f.jobs.map(j=>j.sequence),[1,2,3]);
  assert.deepEqual(f.events.filter(e=>e.metadata.final).map(e=>e.text),['First.','Turn 2.','Turn 3.']);
  assert.match(f.connection.transcription.lastError,/not recognized/,'later successes must not erase the missing-turn warning');
});

test('privacy or session cancellation prevents both active and queued final results', async () => {
  const f = fixture(); f.submit(1,true); f.submit(2,true);
  f.transcriber.configure(f.connection,{memoryOnly:true}); assert.equal(f.jobs[0].signal.aborted,true);
  f.first.resolve('Private late speech.'); await f.entry.chain;
  assert.deepEqual(f.jobs.map(j=>j.sequence),[1]); assert.deepEqual(f.events,[]);
  assert.equal(f.transcriber.buffers.size,0); assert.equal(f.connection.transcription.memoryOnly,true);
});
