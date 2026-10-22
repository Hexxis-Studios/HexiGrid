(() => {
  let callIdentity = { callId: '', mediaEpoch: 0 };
  function setCallIdentity(value = {}) {
    const next = { callId: String(value.id || ''), mediaEpoch: Number(value.mediaEpoch || 0) };
    if (next.callId === callIdentity.callId && next.mediaEpoch === callIdentity.mediaEpoch) return;
    callIdentity = next;
    runtime.speakerQueue = []; runtime.speakerSequence = 0; stopSpeakerPlayback();
    const recorder = runtime.recorder;
    if (recorder) { recorder.onstop = null; runtime.recorder = null; if (recorder.state === 'recording') recorder.stop(); }
    if (!runtime.callAudioPrepared) scheduleMicrophone();
  }
  const runtime = { cameraStream: null, cameraBusy: false, microphoneStream: null, microphoneMuted: false, callAudioPrepared: false, speakerGranted: false, speakerQueue: [], speakerSequence: 0, speakerGeneration: 0, speakerPollInFlight: null, voiceCallPhase: '', speakerPlaying: false, speakerPlaybackBlocked: false, speakerPlaybackError: '', speakerPlaybackMuted: false, speakerLastSequence: 0, speakerLastStartedAt: null, speakerPlayer: null, speakerAudioContext: null, speakerPollTimer: 0, microphoneDeviceId: '', microphoneDeviceLabel: '', microphoneLevel: 0, microphoneAudioContext: null, microphoneAnalyser: null, microphoneLevelFrame: 0, bargeInFrames: 0, bargeInCooldownUntil: 0, cameraTimer: 0, microphoneTimer: 0, healthTimer: 0, recorder: null, request: null, agentName: 'connected Hexonaut', stopping: false, command: null, commandTimer: 0 };

  function state() {
    return { camera: Boolean(runtime.cameraStream), microphone: Boolean(runtime.microphoneStream), microphoneMuted: runtime.microphoneMuted, microphoneAudioContextState: runtime.microphoneAudioContext?.state || 'not-created', speaker: runtime.speakerGranted, speakerPlaying: runtime.speakerPlaying, speakerPlaybackBlocked: runtime.speakerPlaybackBlocked, speakerPlaybackError: runtime.speakerPlaybackError, speakerAudioContextState: runtime.speakerAudioContext?.state || 'not-created', speakerLastSequence: runtime.speakerLastSequence, speakerLastStartedAt: runtime.speakerLastStartedAt, microphoneDeviceId: runtime.microphoneDeviceId, microphoneDeviceLabel: runtime.microphoneDeviceLabel, microphoneLevel: runtime.microphoneLevel, commandActive: Boolean(runtime.command), commandRemainingMs: runtime.command ? Math.max(0, runtime.command.expiresAt - Date.now()) : 0 };
  }

  function announce() { window.dispatchEvent(new CustomEvent('hexigrid-desktop-media', { detail: state() })); }

  function ensureIndicator() {
    let root = document.querySelector('#desktopMediaIndicator');
    if (root) return root;
    root = document.createElement('aside');
    root.id = 'desktopMediaIndicator';
    root.className = 'desktop-media-indicator';
    root.hidden = true;
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.innerHTML = '<div><strong>● Media sharing live</strong><span id="desktopMediaIndicatorText"></span></div><div class="desktop-media-actions"><button type="button" data-stop-media="camera">Stop camera</button><button type="button" data-stop-media="microphone">Stop microphone</button><button type="button" data-stop-media="speaker">Stop agent audio</button></div>';
    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-stop-media]');
      if (button) void stopKind(button.dataset.stopMedia, true);
    });
    document.body.append(root);
    return root;
  }

  function updateIndicator() {
    const root = ensureIndicator();
    const active = [];
    if (runtime.cameraStream) active.push('camera');
    if (runtime.microphoneStream) active.push('microphone');
    if (runtime.speakerGranted) active.push('agent audio');
    root.hidden = active.length === 0;
    const text = root.querySelector('#desktopMediaIndicatorText');
    if (text) text.textContent = active.length ? `${active.join(' + ')} shared with ${runtime.agentName} for this session` : '';
    for (const button of root.querySelectorAll('[data-stop-media]')) button.hidden = !active.includes(button.dataset.stopMedia);
  }

  function stopTracks(stream) { for (const track of stream?.getTracks?.() || []) track.stop(); }

  function stopMicrophoneMeter() {
    if (runtime.microphoneLevelFrame) cancelAnimationFrame(runtime.microphoneLevelFrame);
    runtime.microphoneLevelFrame = 0;
    runtime.microphoneAnalyser = null;
    if (runtime.microphoneMeterNode) {
      runtime.microphoneMeterNode.port.onmessage = null;
      runtime.microphoneMeterNode.disconnect();
      runtime.microphoneMeterNode = null;
    }
    runtime.microphoneLevel = 0;
    runtime.microphoneSource?.disconnect();
    runtime.microphoneSource = null;
    const context = runtime.microphoneAudioContext;
    runtime.microphoneAudioContext = null;
    // Call playback owns the shared, user-unlocked context. Disconnect all
    // capture nodes on hang-up without destroying that browser audio approval.
    if (context && context !== runtime.speakerAudioContext && context.state !== 'closed') void context.close().catch(() => {});
  }

  function stopCommandTimer() {
    if (runtime.commandTimer) clearTimeout(runtime.commandTimer);
    runtime.commandTimer = 0;
    runtime.command = null;
  }

  function stopSpeakerPlayback() {
    runtime.speakerGeneration += 1; runtime.speakerPollInFlight = null; runtime.voiceCallPhase = '';
    if (runtime.speakerPlayer) {
      const player = runtime.speakerPlayer;
      player.onended = null;
      try { player.stop?.(); } catch { /* A source may already have ended. */ }
      try { player.disconnect?.(); } catch { /* A stopped source can already be disconnected. */ }
    }
    runtime.speakerPlayer = null;
    runtime.speakerPlaying = false;
  }

  function speakerAmplitude() {
    if (!runtime.speakerPlaying || runtime.speakerPlaybackMuted || runtime.speakerAudioContext?.state !== 'running' || !runtime.speakerAnalyser) return 0;
    runtime.speakerAnalyser.getFloatTimeDomainData(runtime.speakerSamples);
    let sum = 0;
    for (const sample of runtime.speakerSamples) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / runtime.speakerSamples.length) * 5);
  }

  async function startMicrophoneMeter(stream) {
    try {
      const context = getSpeakerAudioContext();
      if (!context) { announce(); return; }
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      const source = context.createMediaStreamSource(stream);
      runtime.microphoneSource = source;
      source.connect(analyser);
      runtime.microphoneAudioContext = context;
      runtime.microphoneAnalyser = analyser;
      try { await context.resume(); } catch { /* A suspended analyser still fails safely without affecting capture. */ }
      const samples = new Uint8Array(analyser.fftSize);
      const tick = (audioThreadLevel, durationMs = 0) => {
        if (runtime.microphoneAnalyser !== analyser || !runtime.microphoneStream) return;
        const audioThread = typeof audioThreadLevel === 'number';
        if (audioThread) runtime.microphoneLevel = Math.max(0, Math.min(1, audioThreadLevel));
        else {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) { const normalized = (sample - 128) / 128; sum += normalized * normalized; }
          runtime.microphoneLevel = Math.max(0, Math.min(1, Math.sqrt(sum / samples.length) * 3.5));
        }
        if (context.state === 'running' && runtime.microphoneSegmentActivity && (audioThread || !document.hidden)) {
          runtime.microphoneSegmentActivity.measured = true;
          if (runtime.microphoneLevel >= 0.06) runtime.microphoneSegmentActivity.voicedFrames += 1;
          if (audioThread) {
            runtime.microphoneSegmentActivity.elapsedMs += durationMs;
            if (runtime.microphoneSegmentActivity.elapsedMs >= 1000 && runtime.recorder?.state === 'recording') runtime.recorder.stop();
          }
        }
        if ((runtime.speakerPlaying || runtime.voiceCallPhase === 'thinking') && !runtime.microphoneMuted && runtime.microphoneLevel >= 0.12 && Date.now() >= runtime.bargeInCooldownUntil) {
          runtime.bargeInFrames += 1;
          if (runtime.bargeInFrames >= 6) {
            const energy = runtime.microphoneLevel;
            runtime.bargeInFrames = 0;
            runtime.bargeInCooldownUntil = Date.now() + 900;
            runtime.speakerQueue = [];
            stopSpeakerPlayback();
            void upload('/api/desktop-bridge/voice-call/interrupt', { energy }).catch(() => {});
          }
        } else runtime.bargeInFrames = 0;
        if (runtime.command) {
          const now = Date.now();
          if (runtime.microphoneLevel <= runtime.command.silenceLevel) {
            runtime.command.silentSince ||= now;
            if (now - runtime.command.silentSince >= runtime.command.silenceMs) void stopKind('microphone', true);
          } else runtime.command.silentSince = 0;
        }
        announce();
        if (!runtime.microphoneMeterNode) runtime.microphoneLevelFrame = requestAnimationFrame(() => tick());
      };
      if (context.audioWorklet && window.AudioWorkletNode) {
        try {
          await context.audioWorklet.addModule('/microphone-activity-worklet.js');
          if (runtime.microphoneAudioContext !== context) return;
          const meter = new window.AudioWorkletNode(context, 'hexigrid-microphone-activity');
          runtime.microphoneMeterNode = meter;
          meter.port.onmessage = event => { if (runtime.microphoneMeterNode === meter) tick(event.data.level, event.data.durationMs); };
          source.connect(meter); meter.connect(context.destination);
          console.info('[HexiGrid voice audio] background microphone meter ready', { audioContextState: context.state });
          return;
        } catch { console.warn('[HexiGrid voice audio] audio-thread meter unavailable; using visible-page meter'); }
      }
      tick();
    } catch { announce(); }
  }

  async function enumerateMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`
    }));
    if (runtime.microphoneDeviceId && !microphones.some((device) => device.deviceId === runtime.microphoneDeviceId)) {
      runtime.microphoneDeviceId = '';
      runtime.microphoneDeviceLabel = '';
    }
    announce();
    return microphones;
  }

  async function acquireMicrophone(deviceId = '') {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not provide microphone access.');
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio });
    const previous = runtime.microphoneStream;
    const previousRecorder = runtime.recorder;
    runtime.recorder = null;
    if (previousRecorder?.state === 'recording') previousRecorder.stop();
    stopMicrophoneMeter();
    runtime.microphoneStream = stream;
    const trackDeviceId = stream.getAudioTracks?.()[0]?.getSettings?.().deviceId || deviceId || '';
    runtime.microphoneDeviceId = trackDeviceId;
    let devices = [];
    try { devices = await enumerateMicrophones(); } catch { /* Device labels are optional; capture remains active. */ }
    runtime.microphoneDeviceLabel = devices.find((device) => device.deviceId === trackDeviceId)?.label || (trackDeviceId ? 'Selected microphone' : 'System default microphone');
    stopTracks(previous);
    await startMicrophoneMeter(stream);
    announce();
    return state();
  }

  async function blobBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }

  async function uploadAudioBlob(blob, durationMs = 1000, speechActive, identity = callIdentity) {
    if (!blob?.size || !runtime.microphoneStream || runtime.microphoneMuted) return;
    const stream = runtime.microphoneStream, request = runtime.request;
    const data = await blobBase64(blob);
    if (runtime.microphoneStream !== stream || runtime.request !== request || runtime.microphoneMuted || callIdentity !== identity) return;
    await upload('/api/desktop-bridge/media/microphone', { mimeType: (blob.type || 'audio/webm').split(';')[0], data, durationMs,
      ...(identity.callId ? identity : {}),
      ...(typeof speechActive === 'boolean' ? { speechActive } : {}) });
  }

  async function upload(path, body) {
    if (!runtime.request) throw new Error('The owner session is unavailable.');
    return runtime.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  function getSpeakerAudioContext() {
    if (!runtime.speakerAudioContext) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      runtime.speakerAudioContext = new Context();
      runtime.speakerAudioContext.addEventListener?.('statechange', () => {
        runtime.speakerPlaybackBlocked = runtime.speakerAudioContext?.state !== 'running';
        console.info('[HexiGrid voice audio] AudioContext state changed', { state: runtime.speakerAudioContext?.state || 'closed' });
        announce();
      });
    }
    return runtime.speakerAudioContext;
  }

  async function prepareSpeakerPlayback() {
    const context = getSpeakerAudioContext();
    if (!context) throw new Error('Web Audio playback is unavailable in this browser.');
    // Called directly from the owner's Allow/Enable audio gesture so browser
    // autoplay policy can resume the context before queued call audio arrives.
    const resume = context.state === 'running' ? Promise.resolve() : context.resume();
    await resume;
    runtime.speakerPlaybackBlocked = context.state !== 'running';
    console.info('[HexiGrid voice audio] AudioContext prepared', { state: context.state });
    announce();
    if (context.state === 'running') void drainSpeaker();
    return state();
  }

  function segmentBuffer(segment) {
    const binary = atob(String(segment.data || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  async function drainSpeaker() {
    if (!runtime.speakerQueue.length || runtime.speakerPlaying || runtime.speakerPlaybackMuted || !runtime.speakerGranted) return;
    const generation = runtime.speakerGeneration;
    const segment = runtime.speakerQueue.shift();
    const sequence = Number(segment.sequence) || 0;
    const current = () => runtime.speakerGeneration === generation;
    try {
      const context = getSpeakerAudioContext();
      if (!context) throw new Error('Web Audio playback is unavailable in this browser.');
      console.info('[HexiGrid voice audio] chunk received', { sequence, mimeType: segment.mimeType, bytes: Math.ceil(String(segment.data || '').length * 3 / 4), audioContextState: context.state });
      if (context.state !== 'running') {
        runtime.speakerPlaybackBlocked = true;
        runtime.speakerQueue.unshift(segment);
        console.warn('[HexiGrid voice audio] playback waiting for an in-page Allow or Enable audio gesture', { sequence, audioContextState: context.state });
        announce();
        return;
      }
      const decoded = await context.decodeAudioData(segmentBuffer(segment));
      if (!current()) return;
      if (context.state !== 'running') {
        runtime.speakerPlaybackBlocked = true;
        runtime.speakerQueue.unshift(segment);
        console.warn('[HexiGrid voice audio] context suspended during decode; segment remains queued', { sequence, audioContextState: context.state });
        announce();
        return;
      }
      const source = context.createBufferSource();
      source.buffer = decoded;
      // Observe the exact audio already being played; no extra microphone or
      // provider request, and no second output path that could double volume.
      try {
        if (!runtime.speakerAnalyser) {
          runtime.speakerAnalyser = context.createAnalyser(); runtime.speakerAnalyser.fftSize = 256;
          runtime.speakerSamples = new Float32Array(256); runtime.speakerAnalyser.connect(context.destination);
        }
        source.connect(runtime.speakerAnalyser);
      } catch { source.connect(context.destination); }
      runtime.speakerPlayer = source;
      runtime.speakerPlaybackError = '';
      runtime.speakerPlaying = true;
      runtime.speakerPlaybackBlocked = false;
      source.onended = () => {
        if (!current() || runtime.speakerPlayer !== source) return;
        source.disconnect();
        runtime.speakerPlayer = null;
        runtime.speakerPlaying = false;
        console.info('[HexiGrid voice audio] Web Audio source ended', { sequence, audioContextState: context.state });
        announce();
        void drainSpeaker();
      };
      source.start();
      runtime.speakerLastSequence = sequence;
      runtime.speakerLastStartedAt = new Date().toISOString();
      console.info('[HexiGrid voice audio] Web Audio source started', { sequence, durationSeconds: decoded.duration, audioContextState: context.state });
      announce();
    } catch (error) {
      if (!current()) return;
      // A decode failure is not fixed by retrying the same corrupt or
      // unsupported bytes forever. Drop that segment, keep its transcript, and
      // continue to any newer reply.
      runtime.speakerPlaybackBlocked = false;
      runtime.speakerPlaybackError = 'An agent audio clip could not be decoded. Its text remains in the call transcript.';
      runtime.speakerPlaying = false;
      runtime.speakerPlayer = null;
      console.error('[HexiGrid voice audio] decode or playback failed', { sequence, name: error?.name || 'Error', message: String(error?.message || error).slice(0, 240) });
      announce();
      void drainSpeaker();
    }
  }

  async function pollSpeaker() {
    if (!runtime.speakerGranted || !runtime.request || runtime.speakerPollInFlight) return;
    const attempt = { generation: runtime.speakerGeneration, request: runtime.request };
    runtime.speakerPollInFlight = attempt;
    try {
      const result = await attempt.request('/api/desktop-bridge/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ afterSpeakerSequence: runtime.speakerSequence }) });
      if (runtime.speakerPollInFlight !== attempt || runtime.speakerGeneration !== attempt.generation || runtime.request !== attempt.request || !runtime.speakerGranted) return;
      runtime.voiceCallPhase = result.voiceCall?.status === 'active' && !result.voiceCall.ownerMuted ? result.voiceCall.phase : '';
      if (Array.isArray(result.speaker) && result.speaker.length) console.info('[HexiGrid voice audio] media endpoint returned chunks', { count: result.speaker.length, firstSequence: result.speaker[0]?.sequence, lastSequence: result.speaker.at(-1)?.sequence, callStatus: result.voiceCall?.status });
      for (const segment of result.speaker || []) {
        if (!Number.isFinite(Number(segment.sequence)) || Number(segment.sequence) <= runtime.speakerSequence) continue;
        runtime.speakerSequence = Number(segment.sequence);
        if (!runtime.speakerPlaybackMuted) runtime.speakerQueue.push(segment);
      }
      runtime.speakerQueue = runtime.speakerQueue.slice(-12);
      void drainSpeaker();
      announce();
    } catch (error) { console.warn('[HexiGrid voice audio] media endpoint read failed', { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 200) }); }
    finally { if (runtime.speakerPollInFlight === attempt) runtime.speakerPollInFlight = null; }
  }

  async function captureCamera(video, canvas) {
    if (!runtime.cameraStream || runtime.cameraBusy) return;
    if (video.readyState < 2) return;
    const stream = runtime.cameraStream, request = runtime.request, identity = callIdentity;
    runtime.cameraBusy = true;
    try {
      const width = Math.min(480, video.videoWidth || 480);
      const height = Math.max(1, Math.round(width * (video.videoHeight || 270) / (video.videoWidth || 480)));
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.58));
      if (blob) {
        const data = await blobBase64(blob);
        if (runtime.cameraStream === stream && runtime.request === request && identity === callIdentity) await upload('/api/desktop-bridge/media/camera', { mimeType: blob.type, data, width, height, ...(identity.callId ? identity : {}) });
      }
    } finally { runtime.cameraBusy = false; }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not provide camera access.');
    if (runtime.cameraStream) return state();
    runtime.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480, max: 640 }, height: { ideal: 270, max: 480 }, frameRate: { ideal: 2, max: 2 } }, audio: false });
    const video = document.createElement('video'); const canvas = document.createElement('canvas');
    video.srcObject = runtime.cameraStream; video.muted = true; video.playsInline = true; await video.play();
    const tick = () => { void captureCamera(video, canvas).catch(() => {}); };
    tick(); runtime.cameraTimer = window.setInterval(tick, 500);
    updateIndicator(); announce();
    return state();
  }

  function chooseAudioMime() {
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
  }

  function scheduleMicrophone() {
    clearTimeout(runtime.microphoneTimer);
    if (!runtime.microphoneStream || runtime.stopping || runtime.recorder) return;
    const mimeType = chooseAudioMime();
    const chunks = [];
    const stream = runtime.microphoneStream;
    const identity = callIdentity;
    try {
      const recorder = new MediaRecorder(runtime.microphoneStream, mimeType ? { mimeType } : undefined);
      const activity = { measured: false, voicedFrames: 0, elapsedMs: 0 };
      runtime.microphoneSegmentActivity = activity;
      runtime.recorder = recorder;
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        clearTimeout(runtime.microphoneTimer);
        if (runtime.recorder === recorder) runtime.recorder = null;
        if (runtime.microphoneSegmentActivity === activity) runtime.microphoneSegmentActivity = null;
        if (runtime.microphoneStream !== stream || runtime.stopping || callIdentity !== identity) return;
        // Keep recording while encoding/uploading the previous chunk. Awaiting
        // the request here left a gap in every second of the owner's speech.
        scheduleMicrophone();
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
          if (blob.size) await uploadAudioBlob(blob, 1000, activity.measured ? activity.voicedFrames >= 3 : undefined, identity);
        } catch { /* the next session-length segment retries */ }
      };
      recorder.start();
      if (!runtime.microphoneMeterNode) runtime.microphoneTimer = window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 1000);
    } catch { runtime.microphoneTimer = window.setTimeout(scheduleMicrophone, 1000); }
  }

  async function stopKind(kind, notifyServer = false) {
    if (kind === 'camera' || kind === 'all') { clearInterval(runtime.cameraTimer); runtime.cameraTimer = 0; stopTracks(runtime.cameraStream); runtime.cameraStream = null; runtime.cameraBusy = false; }
    if (kind === 'microphone' || kind === 'all') {
      stopCommandTimer();
      clearTimeout(runtime.microphoneTimer); runtime.microphoneTimer = 0;
      runtime.stopping = true;
      if (runtime.recorder?.state === 'recording') runtime.recorder.stop();
      runtime.recorder = null; stopTracks(runtime.microphoneStream); runtime.microphoneStream = null;
      runtime.callAudioPrepared = false;
      stopMicrophoneMeter(); runtime.microphoneDeviceId = ''; runtime.microphoneDeviceLabel = ''; runtime.microphoneMuted = false;
      runtime.bargeInFrames = 0; runtime.bargeInCooldownUntil = 0;
      runtime.stopping = false;
    }
    if (kind === 'speaker' || kind === 'all') {
      clearInterval(runtime.speakerPollTimer); runtime.speakerPollTimer = 0;
      runtime.speakerGranted = false; runtime.speakerQueue = []; runtime.speakerSequence = 0; runtime.speakerPlaybackBlocked = false; runtime.speakerPlaybackMuted = false; runtime.speakerPlaybackError = '';
      stopSpeakerPlayback();
    }
    updateIndicator();
    announce();
    if (notifyServer && runtime.request) await upload('/api/desktop-bridge/media/stop', { kind }).catch(() => {});
    if (kind === 'all') {
      clearInterval(runtime.healthTimer);
      runtime.healthTimer = 0;
      runtime.request = null;
    }
  }

  async function start({ camera = false, microphone = false, speaker = false, microphoneDeviceId = '', microphoneStream = null, preRollBlob = null, preRollDurationMs = 1000, commandTimeoutMs = 0, silenceMs = 0, endWhenSilent = false, agentName, request } = {}) {
    await stopKind('all', false);
    runtime.request = request;
    runtime.agentName = agentName || 'connected Hexonaut';
    runtime.speakerGranted = speaker === true;
    const failures = [];
    if (camera) {
      try { await startCamera(); }
      catch (error) { failures.push(`Camera: ${error.message}`); }
    }
    if (microphone) {
      try {
        if (microphoneStream) {
          runtime.microphoneStream = microphoneStream;
          const trackDeviceId = microphoneStream.getAudioTracks?.()[0]?.getSettings?.().deviceId || microphoneDeviceId || '';
          runtime.microphoneDeviceId = trackDeviceId;
          const devices = await enumerateMicrophones().catch(() => []);
          runtime.microphoneDeviceLabel = devices.find((device) => device.deviceId === trackDeviceId)?.label || (trackDeviceId ? 'Selected microphone' : 'System default microphone');
          await startMicrophoneMeter(microphoneStream);
        } else await acquireMicrophone(microphoneDeviceId);
        if (preRollBlob) await uploadAudioBlob(preRollBlob, preRollDurationMs);
      }
      catch (error) { failures.push(`Microphone: ${error.message}`); }
    }
    updateIndicator();
    if (runtime.microphoneStream) {
      if (endWhenSilent) {
        const timeout = Math.min(30000, Math.max(2000, Number(commandTimeoutMs) || 12000));
        runtime.command = { silenceMs: Math.min(4000, Math.max(400, Number(silenceMs) || 1200)), silenceLevel: 0.035, silentSince: 0, expiresAt: Date.now() + timeout };
        runtime.commandTimer = window.setTimeout(() => { void stopKind('microphone', true); }, timeout);
      }
      scheduleMicrophone();
    }
    clearInterval(runtime.healthTimer);
    runtime.healthTimer = 0;
    ensureHealthTimer();
    clearInterval(runtime.speakerPollTimer);
    if (runtime.speakerGranted) { void pollSpeaker(); runtime.speakerPollTimer = window.setInterval(() => { void pollSpeaker(); }, 650); }
    return { cameraActive: Boolean(runtime.cameraStream), microphoneActive: Boolean(runtime.microphoneStream), speakerActive: runtime.speakerGranted, failures };
  }

  function ensureHealthTimer() {
    if (runtime.healthTimer) return;
    runtime.healthTimer = window.setInterval(async () => {
      if (!runtime.cameraStream && !runtime.microphoneStream && !runtime.speakerGranted) return;
      try {
        const result = await runtime.request('/api/desktop-bridge');
        if (!result.bridge?.enabled) await stopKind('all', false);
        else {
          if (!result.media?.cameraGranted && runtime.cameraStream) await stopKind('camera', false);
          if (!result.media?.microphoneGranted && runtime.microphoneStream) await stopKind('microphone', false);
          if (!result.media?.speakerGranted && runtime.speakerGranted) await stopKind('speaker', false);
        }
      } catch { await stopKind('all', false); }
    }, 2000);
  }

  async function setKind(kind, enabled, { request, microphoneDeviceId = '', agentName = '' } = {}) {
    if (!['camera', 'microphone', 'speaker'].includes(kind)) throw new Error('Choose camera, microphone, or speaker.');
    if (!runtime.request && typeof request === 'function') runtime.request = request;
    if (!runtime.request) throw new Error('The owner session is unavailable.');
    if (!enabled) {
      await stopKind(kind, false);
      await upload('/api/desktop-bridge/media/switch', { kind, enabled: false });
      return state();
    }
    if (agentName) runtime.agentName = agentName;
    await upload('/api/desktop-bridge/media/switch', { kind, enabled: true, approved: true });
    try {
      if (kind === 'camera') await startCamera();
      if (kind === 'microphone') { if (!runtime.microphoneStream) await acquireMicrophone(microphoneDeviceId); if (!runtime.callAudioPrepared) scheduleMicrophone(); }
      if (kind === 'speaker') {
        runtime.speakerGranted = true;
        void pollSpeaker();
        clearInterval(runtime.speakerPollTimer);
        runtime.speakerPollTimer = window.setInterval(() => { void pollSpeaker(); }, 650);
      }
      ensureHealthTimer();
      updateIndicator(); announce();
      return state();
    } catch (error) {
      await stopKind(kind, false);
      await upload('/api/desktop-bridge/media/switch', { kind, enabled: false }).catch(() => {});
      throw error;
    }
  }

  async function switchMicrophone(deviceId = '') {
    if (!runtime.microphoneStream) {
      runtime.microphoneDeviceId = String(deviceId || '');
      runtime.microphoneDeviceLabel = '';
      announce();
      return state();
    }
    try {
      const result = await acquireMicrophone(String(deviceId || ''));
      if (runtime.microphoneStream) scheduleMicrophone();
      return result;
    }
    catch (error) { announce(); throw error; }
  }

  async function enableSpeaker() {
    return prepareSpeakerPlayback();
  }

  async function prepareCallAudioFromGesture({ request, agentName } = {}) {
    if (typeof request === 'function') runtime.request = request;
    if (!runtime.request) throw new Error('The owner session is unavailable.');
    if (agentName) runtime.agentName = agentName;
    const context = getSpeakerAudioContext();
    if (!context) throw new Error('Web Audio playback is unavailable in this browser.');
    // Start both browser-controlled operations synchronously from the user's
    // Allow click: microphone access uses getUserMedia, and speaker playback
    // resumes under the browser's transient user activation.
    const resumePromise = context.state === 'running' ? Promise.resolve() : context.resume();
    const microphonePromise = runtime.microphoneStream
      ? Promise.resolve(runtime.microphoneStream)
      : acquireMicrophone(runtime.microphoneDeviceId);
    const [, microphone] = await Promise.all([resumePromise, microphonePromise]);
    if (!runtime.microphoneStream) runtime.microphoneStream = microphone;
    runtime.callAudioPrepared = true;
    runtime.speakerPlaybackBlocked = context.state !== 'running';
    console.info('[HexiGrid voice audio] browser permissions prepared before call acceptance', { microphoneTrackCount: runtime.microphoneStream?.getAudioTracks?.().length || 0, audioContextState: context.state });
    announce();
    return state();
  }

  function activateCallAudio() {
    if (!runtime.request || !runtime.microphoneStream) throw new Error('Microphone access is not ready for this call.');
    runtime.callAudioPrepared = false;
    scheduleMicrophone();
    runtime.speakerGranted = true;
    runtime.speakerPlaybackBlocked = runtime.speakerAudioContext?.state !== 'running';
    clearInterval(runtime.speakerPollTimer);
    void pollSpeaker();
    runtime.speakerPollTimer = window.setInterval(() => { void pollSpeaker(); }, 650);
    ensureHealthTimer();
    updateIndicator();
    console.info('[HexiGrid voice audio] accepted call media is active', { microphoneTrackCount: runtime.microphoneStream.getAudioTracks?.().length || 0, audioContextState: runtime.speakerAudioContext?.state || 'not-created' });
    announce();
    return state();
  }

  async function setCameraEnabled(enabled = true) {
    if (!runtime.request) throw new Error('The owner session is unavailable.');
    if (enabled !== true) { await stopKind('camera', true); return state(); }
    await upload('/api/desktop-bridge/media/camera-state', { enabled: true });
    try { return await startCamera(); }
    catch (error) {
      await upload('/api/desktop-bridge/media/camera-state', { enabled: false }).catch(() => {});
      throw error;
    }
  }

  function setMicrophoneMuted(muted = true) {
    runtime.microphoneMuted = muted === true;
    announce();
    return state();
  }

  function setVoicePlaybackMuted(muted = true) {
    runtime.speakerPlaybackMuted = muted === true;
    if (runtime.speakerPlaybackMuted) { runtime.speakerQueue = []; stopSpeakerPlayback(); }
    else void drainSpeaker();
    announce();
    return state();
  }

  navigator.mediaDevices?.addEventListener?.('devicechange', () => { void enumerateMicrophones(); });
  function attachCameraPreview(video) {
    // Reuse the already-approved camera. This never acquires media or changes
    // grants, and preview audio must never echo the call back to the owner.
    if (!video) return false;
    const stream = runtime.cameraStream;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = true; video.playsInline = true;
    if (stream && video.paused) void video.play().catch(() => {});
    return Boolean(stream);
  }
  window.HexiGridDesktopMedia = { start, stop: stopKind, setKind, active: state, state, sessionReady: () => Boolean(runtime.request), enumerateMicrophones, switchMicrophone, enableSpeaker, prepareSpeakerPlayback, prepareCallAudioFromGesture, activateCallAudio, setCameraEnabled, setMicrophoneMuted, setVoicePlaybackMuted, attachCameraPreview, speakerAmplitude, setCallIdentity };
  window.addEventListener('pagehide', () => { void stopKind('all', false); });
})();
