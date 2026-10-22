(() => {
  let stream = null;
  let video = null;
  let canvas = null;
  let timer = null;
  let busy = false;
  let requestFn = null;
  let lastError = '';
  let generation = 0;

  const emit = (detail = {}) => window.dispatchEvent(new CustomEvent('hexigrid-desktop-screen', { detail: { active: Boolean(stream), lastError, ...detail } }));

  function stopTracks() {
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
    video?.remove?.();
    video = null;
    canvas = null;
    if (timer) window.clearInterval(timer);
    timer = null;
    busy = false;
  }

  async function sendFrame() {
    if (!stream || !video || !canvas || busy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !requestFn) return;
    busy = true;
    try {
      const maxWidth = 1600;
      const scale = Math.min(1, maxWidth / Math.max(1, video.videoWidth));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d', { alpha: false });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const encoded = canvas.toDataURL('image/jpeg', 0.72).split(',', 2)[1] || '';
      if (!encoded) throw new Error('The browser did not produce a screen frame.');
      await requestFn('/api/desktop-bridge/browser-frame', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: 'image/jpeg', data: encoded, capturedAt: new Date().toISOString() })
      });
      lastError = '';
      emit({ capturedAt: new Date().toISOString() });
    } catch (error) {
      lastError = error?.message || 'The browser screen frame could not be sent.';
      if ([403, 409].includes(Number(error?.status))) stopTracks();
      emit();
    } finally { busy = false; }
  }

  async function start({ request } = {}) {
    if (typeof request !== 'function') throw new Error('The owner screen bridge is not connected.');
    const attempt = ++generation;
    stopTracks();
    requestFn = request;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot share the owner screen.');
    let grantedStream;
    try { grantedStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: 4 } }, audio: false }); }
    catch (error) { if (attempt !== generation) return { active: false, cancelled: true }; throw error; }
    if (attempt !== generation) { grantedStream.getTracks?.().forEach((track) => track.stop()); return { active: false, cancelled: true }; }
    stream = grantedStream;
    const track = stream.getVideoTracks()[0];
    if (!track) { stopTracks(); throw new Error('No screen track was granted.'); }
    track.addEventListener('ended', () => { lastError = 'Screen sharing ended in the browser.'; stopTracks(); emit(); }, { once: true });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;';
    video.srcObject = stream;
    document.body.append(video);
    canvas = document.createElement('canvas');
    try { await video.play(); }
    catch (error) {
      if (attempt !== generation || stream !== grantedStream) return { active: false, cancelled: true };
      stopTracks();
      emit();
      throw error;
    }
    if (attempt !== generation || stream !== grantedStream) {
      if (stream === grantedStream) stopTracks();
      return { active: false, cancelled: true };
    }
    await sendFrame();
    timer = window.setInterval(() => { void sendFrame(); }, 900);
    emit();
    return { active: true };
  }

  function stop() {
    generation += 1;
    stopTracks();
    lastError = '';
    emit();
  }

  window.HexiGridDesktopScreen = Object.freeze({ start, stop, active: () => Boolean(stream), state: () => ({ active: Boolean(stream), lastError }) });
})();
