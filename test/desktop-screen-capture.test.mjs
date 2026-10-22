import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/desktop-screen-capture.js', import.meta.url), 'utf8');

function fixture({ play } = {}) {
  const events = [];
  let video;
  let intervals = 0;
  const tracks = [{ stopped: false, stop() { this.stopped = true; }, addEventListener() {} }];
  const stream = { getTracks: () => tracks, getVideoTracks: () => tracks };
  const window = { dispatchEvent: event => events.push(event) };
  const document = {
    body: { append() {} },
    createElement(name) {
      if (name === 'video') return video = {
        readyState: 2, videoWidth: 640, videoHeight: 480, style: {},
        setAttribute() {}, remove() { this.removed = true; },
        play: play || (() => Promise.resolve())
      };
      return { getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,c3ludGhldGlj' };
    }
  };
  const context = {
    window, document, navigator: { mediaDevices: { getDisplayMedia: async () => stream } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    setInterval() { return ++intervals; }, clearInterval() {}
  };
  vm.runInNewContext(source, context);
  return { api: window.HexiGridDesktopScreen, events, stream, tracks, get video() { return video; }, get intervals() { return intervals; } };
}

test('stopping during browser screen playback discards the late start', async () => {
  let resumePlayback;
  let uploads = 0;
  const ui = fixture({ play: () => new Promise(resolve => { resumePlayback = resolve; }) });
  const starting = ui.api.start({ request: async () => { uploads++; } });
  await new Promise(resolve => setImmediate(resolve));
  ui.api.stop();
  resumePlayback();

  const result = await starting;
  assert.equal(result.active, false);
  assert.equal(result.cancelled, true);
  assert.equal(ui.api.active(), false);
  assert.equal(ui.tracks[0].stopped, true);
  assert.equal(ui.intervals, 0);
  assert.equal(uploads, 0);
});

test('failed browser playback releases the selected screen track', async () => {
  const ui = fixture({ play: async () => { throw new Error('Playback was blocked.'); } });
  await assert.rejects(ui.api.start({ request: async () => {} }), /Playback was blocked/);
  assert.equal(ui.api.active(), false);
  assert.equal(ui.tracks[0].stopped, true);
  assert.equal(ui.video.removed, true);
  assert.equal(ui.intervals, 0);
});
