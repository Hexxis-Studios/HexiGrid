import test from 'node:test';
import assert from 'node:assert/strict';
import { AvatarPresenceRuntime } from '../lib/avatar-presence-runtime.mjs';
import { publicAvatarPresence, updateAvatarPresence } from '../lib/avatar-presence.mjs';

test('call presence uses exact agent revisions and cannot overwrite a later signed change', () => {
  const agents = [{ id: 'a' }, { id: 'b' }];
  let callback, changes = 0;
  const runtime = new AvatarPresenceRuntime({ findAgent: id => agents.find(a => a.id === id),
    onChange: () => changes++, setTimer: fn => { callback = fn; return { unref() {} }; }, cancelTimer: () => {} });
  const listening = runtime.start({ agentId: 'a', state: 'listening' });
  assert.equal(listening.revision, 1);
  runtime.setStateFor('speaking');
  const stale = callback;
  updateAvatarPresence(agents[0], { state: 'thinking', expectedRevision: 2 });
  stale();
  assert.equal(runtime.status().state, 'thinking');
  runtime.setStateFor('speaking');
  callback();
  assert.equal(runtime.status().state, 'listening');
  runtime.start({ agentId: 'b' });
  stale();
  runtime.hide();
  assert.equal(publicAvatarPresence(agents[1]).visible, false);
  assert.equal(publicAvatarPresence(agents[0]).visible, true);
  assert.equal(publicAvatarPresence(agents[0]).state, 'listening');
  assert.equal(changes, 6);
  runtime.stop();
});
