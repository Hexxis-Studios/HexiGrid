(() => {
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let limitTimer = 0;
  const MAX_DURATION_MS = 15 * 60 * 1000;
  const MAX_BYTES = 250 * 1024 * 1024;

  function supported() {
    return typeof window.MediaRecorder === 'function' && typeof window.MediaStream === 'function';
  }

  function chooseMimeType() {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'audio/webm;codecs=opus', 'audio/webm'];
    return candidates.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || '';
  }

  function render() {
    const root = document.querySelector('#liveRecordingControls');
    if (!root) return;
    if (!supported()) {
      root.innerHTML = '<p class="microcopy">This browser cannot record media. Transcript saving still works.</p>';
      return;
    }
    const active = recorder?.state === 'recording';
    root.innerHTML = `<button class="${active ? 'danger-button' : 'secondary-button'}" type="button" data-live-recording-action="${active ? 'stop' : 'start'}">${active ? 'Stop & save recording' : 'Record to this device'}</button><span class="live-recording-note">${active ? 'Recording now · maximum 15 minutes' : 'Off by default · saved only when you choose'}</span>`;
  }

  function reset() {
    clearTimeout(limitTimer);
    limitTimer = 0;
    recorder = null;
    chunks = [];
    startedAt = 0;
    render();
  }

  function downloadRecording(parts, mimeType, timestamp) {
    const blob = new Blob(parts, { type: mimeType || 'video/webm' });
    if (!blob.size) throw new Error('The browser did not produce any recording data.');
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hexigrid-live-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return blob.size;
  }

  function stop() {
    if (recorder?.state === 'recording') recorder.stop();
  }

  function start() {
    if (!supported()) return window.HexiGridLiveCall?.setStatus('Recording is not supported by this browser.', true);
    const stream = window.HexiGridLiveCall?.activeMediaStream?.();
    if (!stream?.getTracks().length) return window.HexiGridLiveCall?.setStatus('Start the camera or screen preview before recording.', true);
    chunks = [];
    startedAt = Date.now();
    const mimeType = chooseMimeType();
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 } : undefined);
    } catch (error) {
      reset();
      return window.HexiGridLiveCall?.setStatus(`Recording could not start: ${error.message}`, true);
    }
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
      const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      if (total >= MAX_BYTES && recorder?.state === 'recording') recorder.stop();
    };
    recorder.onerror = (event) => window.HexiGridLiveCall?.setStatus(`Recording failed: ${event.error?.message || 'browser error'}`, true);
    recorder.onstop = () => {
      try {
        const bytes = downloadRecording(chunks, recorder?.mimeType, startedAt);
        window.HexiGridLiveCall?.setStatus(`Recording saved to this device (${Math.max(1, Math.round(bytes / 1024))} KB).`);
      } catch (error) {
        window.HexiGridLiveCall?.setStatus(error.message, true);
      } finally { reset(); }
    };
    recorder.start(1000);
    limitTimer = setTimeout(stop, MAX_DURATION_MS);
    window.HexiGridLiveCall?.setStatus('Recording locally. Stop it when you are finished.');
    render();
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-live-recording-action]');
    if (!button) return;
    if (button.dataset.liveRecordingAction === 'start') start();
    else stop();
  });
  window.addEventListener('hexigrid:rendered', render);
  window.addEventListener('beforeunload', () => { clearTimeout(limitTimer); });
  window.HexiGridLiveRecording = Object.freeze({ supported, start, stop, render });
})();
