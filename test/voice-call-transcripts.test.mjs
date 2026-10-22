import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallTranscriptBuffer } from '../lib/voice-call-transcripts.mjs';

const call = { id: 'call-a', linkId: 'link-a', status: 'active', direction: 'agent-to-owner' };
const transcript = (type, text) => ({ type: `speech.transcript.${type}`, text });

test('transcript view is temporary and scoped to the exact active Link/call and enabled non-memory-only transcription', () => {
  const buffer = new VoiceCallTranscriptBuffer();
  buffer.begin({ ...call, status: 'ringing' });
  assert.equal(buffer.add({ linkId: 'link-a', call, event: transcript('final', 'Hello there.') }), true);
  assert.equal(buffer.read({ linkId: 'link-a', call, enabled: true })[0].text, 'Hello there.');
  assert.deepEqual(buffer.read({ linkId: 'link-b', call, enabled: true }), []);
  assert.deepEqual(buffer.read({ linkId: 'link-a', call: { ...call, id: 'call-b' }, enabled: true }), []);
  assert.deepEqual(buffer.read({ linkId: 'link-a', call: { ...call, status: 'ended' }, enabled: true }), []);
  assert.deepEqual(buffer.read({ linkId: 'link-a', call, enabled: false }), []);
});

test('partials are replaced by the final utterance and retained history is bounded', () => {
  const buffer = new VoiceCallTranscriptBuffer();
  buffer.begin(call);
  buffer.add({ linkId: 'link-a', call, event: transcript('partial', 'I would like') });
  buffer.add({ linkId: 'link-a', call, event: transcript('partial', 'I would like some tea') });
  buffer.add({ linkId: 'link-a', call, event: transcript('final', 'I would like some tea.') });
  assert.deepEqual(buffer.read({ linkId: 'link-a', call, enabled: true }).map(line => [line.text, line.final]), [['I would like some tea.', true]]);
  for (let index = 0; index < 55; index += 1) buffer.add({ linkId: 'link-a', call, event: transcript('final', `Line ${index}`) });
  const lines = buffer.read({ linkId: 'link-a', call, enabled: true });
  assert.equal(lines.length, 40);
  assert.equal(lines.at(-1).text, 'Line 54');
});

test('starting a different call clears transcript records from the previous caller', () => {
  const buffer = new VoiceCallTranscriptBuffer();
  buffer.begin(call);
  buffer.add({ linkId: 'link-a', call, event: transcript('final', 'Private phrase.') });
  buffer.begin({ id: 'call-b', linkId: 'link-b', status: 'ringing' });
  assert.deepEqual(buffer.read({ linkId: 'link-a', call, enabled: true }), []);
});
