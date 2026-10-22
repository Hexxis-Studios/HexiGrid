/* Local-only wake phrase gate. No audio request, upload, or relay lives here. */
(() => {
  const MAX_RING_SECONDS = 2;
  const MAX_TRAINING_SAMPLES = 3;
  const DETECTOR = 'local-template-v3';
  const DETECTION_THRESHOLD = 0.80;
  const DETECTION_MARGIN = 0.08;
  const EVALUATION_INTERVAL_MS = 120;
  const featurePlans = new Map();
  const DEFAULTS = { enabled: false, alwaysListening: false, pushToTalk: true, agentId: '', phrase: 'Hey Hexi', preRollMs: 1000, silenceMs: 1200, commandTimeoutMs: 12000, samples: [] };
  const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  const cleanPhrase = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const mel = (frequency) => 2595 * Math.log10(1 + frequency / 700);
  const hertz = (melValue) => 700 * (10 ** (melValue / 2595) - 1);
  const featurePlan = (frameSize, sampleRate) => {
    const safeRate = clamp(sampleRate, 8000, 192000, 16000); const key = `${frameSize}:${safeRate}`;
    if (featurePlans.has(key)) return featurePlans.get(key);
    const filterCount = 20; const coefficientCount = 13; const nyquist = safeRate / 2;
    const lowMel = mel(80); const highMel = mel(Math.min(8000, nyquist));
    const melPoints = Array.from({ length: filterCount + 2 }, (_, index) => lowMel + (highMel - lowMel) * index / (filterCount + 1));
    const bins = melPoints.map((value) => Math.max(0, Math.min(frameSize / 2, Math.floor((frameSize + 1) * hertz(value) / safeRate))));
    const filters = Array.from({ length: filterCount }, (_, filter) => {
      const left = bins[filter]; const center = Math.max(left + 1, bins[filter + 1]); const right = Math.max(center + 1, bins[filter + 2]); const weights = [];
      for (let bin = left; bin < center; bin += 1) weights.push([bin, (bin - left) / Math.max(1, center - left)]);
      for (let bin = center; bin <= right; bin += 1) weights.push([bin, (right - bin) / Math.max(1, right - center)]);
      return weights;
    });
    const dct = Array.from({ length: coefficientCount }, (_, coefficient) => Array.from({ length: filterCount }, (__, filter) => Math.cos(Math.PI * coefficient * (filter + 0.5) / filterCount)));
    const window = Float64Array.from({ length: frameSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, frameSize - 1)));
    const fftStages = []; for (let length = 2; length <= frameSize; length <<= 1) fftStages.push({ length, cosine: Math.cos(-2 * Math.PI / length), sine: Math.sin(-2 * Math.PI / length) });
    const plan = { filters, dct, window, fftStages };
    if (featurePlans.size >= 8) featurePlans.delete(featurePlans.keys().next().value);
    featurePlans.set(key, plan); return plan;
  };
  const powerSpectrum = (frame, plan, real, imaginary, power) => {
    const size = frame.length; real.fill(0); imaginary.fill(0);
    let previous = 0;
    for (let index = 0; index < size; index += 1) { const sample = Number(frame[index]) || 0; const emphasized = sample - 0.97 * previous; previous = sample; real[index] = emphasized * plan.window[index]; }
    for (let index = 1, reversed = 0; index < size; index += 1) {
      let bit = size >> 1; for (; reversed & bit; bit >>= 1) reversed ^= bit; reversed ^= bit;
      if (index < reversed) { const swap = real[index]; real[index] = real[reversed]; real[reversed] = swap; }
    }
    for (const { length, cosine, sine } of plan.fftStages) {
      for (let start = 0; start < size; start += length) {
        let wr = 1; let wi = 0;
        for (let offset = 0; offset < length / 2; offset += 1) {
          const even = start + offset; const odd = even + length / 2; const oddReal = real[odd] * wr - imaginary[odd] * wi; const oddImaginary = real[odd] * wi + imaginary[odd] * wr;
          real[odd] = real[even] - oddReal; imaginary[odd] = imaginary[even] - oddImaginary; real[even] += oddReal; imaginary[even] += oddImaginary;
          const nextWr = wr * cosine - wi * sine; wi = wr * sine + wi * cosine; wr = nextWr;
        }
      }
    }
    for (let index = 0; index < power.length; index += 1) power[index] = (real[index] ** 2 + imaginary[index] ** 2) / size;
    return power;
  };
  const createFeatureExtractor = (sampleRate = 16000, frameSize = 1024) => {
    const size = 2 ** Math.max(8, Math.min(12, Math.round(Math.log2(frameSize)))); const hop = Math.max(128, size / 2); const plan = featurePlan(size, sampleRate);
    let pending = new Float32Array(0); let noiseFloor = null; let noiseFrames = 0; const fftReal = new Float64Array(size); const fftImaginary = new Float64Array(size); const fftPower = new Float64Array(size / 2 + 1);
    const push = (samples) => {
      const input = new Float32Array(pending.length + samples.length); input.set(pending); input.set(samples, pending.length); const frames = []; let offset = 0;
      for (; offset + size <= input.length; offset += hop) {
        const frame = input.subarray(offset, offset + size); let energy = 0; let crossings = 0; let previous = frame[0] || 0;
        for (let index = 0; index < frame.length; index += 1) { const sample = Number(frame[index]) || 0; energy += sample * sample; if ((sample >= 0) !== (previous >= 0)) crossings += 1; previous = sample; }
        const rms = Math.sqrt(energy / frame.length); const power = powerSpectrum(frame, plan, fftReal, fftImaginary, fftPower);
        if (!noiseFloor) noiseFloor = new Float64Array(power.length);
        const totalPower = power.reduce((sum, value) => sum + value, 0); const noisePower = noiseFloor.reduce((sum, value) => sum + value, 0);
        const calibrating = noiseFrames < 12; const speech = !calibrating && totalPower > Math.max(1e-12, noisePower * 2.4);
        if (calibrating || !speech) {
          const alpha = calibrating ? 1 / (noiseFrames + 1) : 0.035;
          for (let bin = 0; bin < power.length; bin += 1) noiseFloor[bin] += (power[bin] - noiseFloor[bin]) * alpha;
          noiseFrames += 1;
        } else {
          for (let bin = 0; bin < power.length; bin += 1) if (power[bin] < noiseFloor[bin]) noiseFloor[bin] += (power[bin] - noiseFloor[bin]) * 0.002;
        }
        const bands = plan.filters.map((filter) => Math.log(1e-12 + filter.reduce((sum, [bin, weight]) => {
          const observed = power[bin] || 0; const cleaned = Math.max(observed * 0.015, observed - (noiseFloor[bin] || 0) * 1.1); return sum + cleaned * weight;
        }, 0)));
        const coefficients = plan.dct.map((row) => row.reduce((sum, weight, index) => sum + weight * bands[index], 0) / bands.length);
        frames.push([Math.log1p(rms * 100), crossings / frame.length, ...coefficients.slice(1)]);
      }
      pending = input.slice(offset); return frames;
    };
    return Object.freeze({ push, reset: () => { pending = new Float32Array(0); noiseFloor = null; noiseFrames = 0; } });
  };
  const frameFeatures = (samples, frameSize = 1024, sampleRate = 16000) => createFeatureExtractor(sampleRate, frameSize).push(samples);
  const normalize = (frames) => {
    if (!frames.length) return [];
    const width = frames[0].length; const means = Array(width).fill(0); const scales = Array(width).fill(0);
    for (const frame of frames) for (let index = 0; index < width; index += 1) means[index] += frame[index] || 0;
    for (let index = 0; index < width; index += 1) means[index] /= frames.length;
    for (const frame of frames) for (let index = 0; index < width; index += 1) scales[index] += ((frame[index] || 0) - means[index]) ** 2;
    for (let index = 0; index < width; index += 1) scales[index] = Math.sqrt(scales[index] / frames.length) || 1;
    return frames.map((frame) => frame.map((value, index) => ((value || 0) - means[index]) / scales[index]));
  };
  const resample = (frames, count) => Array.from({ length: count }, (_, index) => frames[Math.min(frames.length - 1, Math.floor(index * frames.length / count))]);
  const similarity = (recent, template) => {
    if (!recent.length || !template.length) return 0;
    const count = Math.max(8, Math.min(180, template.length)); const left = resample(recent, count); const right = resample(template, count);
    let aligned = 0; let deltaAligned = 0;
    const cosine = (a, b) => { let dot = 0; let aa = 0; let bb = 0; const width = Math.min(a.length, b.length); for (let index = 0; index < width; index += 1) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; };
    const cosineDelta = (a, previousA, b, previousB) => { let dot = 0; let aa = 0; let bb = 0; const width = Math.min(a.length, previousA.length, b.length, previousB.length); for (let index = 0; index < width; index += 1) { const leftDelta = a[index] - previousA[index]; const rightDelta = b[index] - previousB[index]; dot += leftDelta * rightDelta; aa += leftDelta ** 2; bb += rightDelta ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; };
    for (let frame = 0; frame < count; frame += 1) {
      aligned += (cosine(left[frame], right[frame]) + 1) / 2;
      if (frame > 0) deltaAligned += (cosineDelta(left[frame], left[frame - 1], right[frame], right[frame - 1]) + 1) / 2;
    }
    const staticScore = aligned / count; const deltaScore = count > 1 ? deltaAligned / (count - 1) : staticScore;
    return staticScore * 0.72 + deltaScore * 0.28;
  };
  const scoreCandidate = (recent, template) => {
    if (!recent.length || !template.length) return 0;
    let best = 0;
    for (const scale of [0.75, 0.9, 1, 1.1, 1.25]) {
      const length = Math.max(8, Math.min(recent.length, Math.round(template.length * scale)));
      best = Math.max(best, similarity(normalize(recent.slice(-length)), template));
    }
    return best;
  };
  const pcmWav = (samples, sampleRate) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
    const write = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, samples[index])) * 0x7fff, true);
    return new Blob([buffer], { type: 'audio/wav' });
  };

  function createWakeWordEngine({ onState, onTrigger, onError } = {}) {
    const runtime = { settings: { ...DEFAULTS }, stream: null, context: null, source: null, processor: null, extractor: null, ring: [], recent: [], templates: [], enabled: false, training: null, commandActive: false, lastTriggerAt: 0, lastEvaluationAt: 0, sampleRate: 16000, processedFrames: 0 };
    const emit = () => onState?.(state());
    function state() { return { enabled: runtime.enabled, localDetector: Boolean(runtime.stream), commandActive: runtime.commandActive, alwaysListening: runtime.settings.alwaysListening, pushToTalk: runtime.settings.pushToTalk, phrase: runtime.settings.phrase, trained: runtime.templates.length > 0, sampleCount: runtime.templates.length, preRollMs: runtime.settings.preRollMs, detector: DETECTOR, resourceBounds: { ringSamples: runtime.ring.length, featureFrames: runtime.recent.length, processedFrames: runtime.processedFrames, maxRingSeconds: MAX_RING_SECONDS } }; }
    function setSettings(next = {}) {
      runtime.settings = { ...runtime.settings, ...next, agentId: String((next.agentId ?? runtime.settings.agentId) || ''), phrase: cleanPhrase(next.phrase ?? runtime.settings.phrase) || DEFAULTS.phrase, preRollMs: clamp(next.preRollMs ?? runtime.settings.preRollMs, 250, 2000, 1000), silenceMs: clamp(next.silenceMs ?? runtime.settings.silenceMs, 400, 4000, 1200), commandTimeoutMs: clamp(next.commandTimeoutMs ?? runtime.settings.commandTimeoutMs, 2000, 30000, 12000) };
      emit(); return state();
    }
    function setTemplates(samples = []) {
      runtime.templates = samples.map((item) => {
        if (Array.isArray(item)) return { agentId: '', phrase: runtime.settings.phrase, frames: item };
        if (item && typeof item === 'object' && Array.isArray(item.frames)) return { agentId: String(item.agentId || ''), phrase: cleanPhrase(item.phrase) || runtime.settings.phrase, frames: item.frames };
        return null;
      }).filter((item) => item?.frames?.length);
      emit(); return state();
    }
    function disconnectDetector({ stopStream = true } = {}) {
      runtime.processor?.disconnect?.(); runtime.source?.disconnect?.(); runtime.processor = null; runtime.source = null;
      const context = runtime.context; runtime.context = null;
      if (context && context.state !== 'closed') void context.close().catch(() => {});
      if (stopStream) for (const track of runtime.stream?.getTracks?.() || []) track.stop();
      if (stopStream) { runtime.stream = null; runtime.extractor = null; }
    }
    function takeStream() { disconnectDetector({ stopStream: false }); const stream = runtime.stream; runtime.stream = null; runtime.commandActive = true; emit(); return stream; }
    function trigger(reason = 'wake-word', template = null) {
      const now = Date.now(); if (!runtime.templates.length || now - runtime.lastTriggerAt < 1800 || runtime.commandActive) return;
      runtime.lastTriggerAt = now;
      const samples = runtime.ring.slice(-Math.round(runtime.sampleRate * runtime.settings.preRollMs / 1000));
      const preRollBlob = pcmWav(samples, runtime.sampleRate);
      const stream = takeStream();
      onTrigger?.({ reason, agentId: template?.agentId || '', phrase: template?.phrase || runtime.settings.phrase, stream, preRollBlob, preRollDurationMs: runtime.settings.preRollMs });
    }
    async function connectLocal() {
      if (runtime.stream) return runtime.stream;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot run a local wake-word detector.');
      runtime.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('This browser cannot run local audio analysis.');
      runtime.context = new AudioContext(); runtime.sampleRate = runtime.context.sampleRate; runtime.extractor = createFeatureExtractor(runtime.sampleRate, 1024);
      runtime.source = runtime.context.createMediaStreamSource(runtime.stream); runtime.processor = runtime.context.createScriptProcessor(2048, 1, 1);
      const mute = runtime.context.createGain(); mute.gain.value = 0;
      runtime.processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0); const copy = new Float32Array(input); runtime.ring.push(...copy); const maxSamples = Math.round(runtime.sampleRate * MAX_RING_SECONDS); if (runtime.ring.length > maxSamples) runtime.ring.splice(0, runtime.ring.length - maxSamples);
        const features = runtime.extractor.push(copy); runtime.processedFrames += features.length; runtime.recent.push(...features); runtime.recent = runtime.recent.slice(-240);
        if (runtime.training) { runtime.training.frames.push(...features); if (Date.now() >= runtime.training.endsAt) { const result = normalize(runtime.training.frames.slice(-240)); const done = runtime.training.resolve; runtime.training = null; done(result); emit(); } }
        const now = Date.now();
        if (runtime.enabled && !runtime.training && !runtime.commandActive && now - runtime.lastEvaluationAt >= EVALUATION_INTERVAL_MS) {
          runtime.lastEvaluationAt = now;
          const candidates = runtime.templates.map((template) => ({ template, score: scoreCandidate(runtime.recent, template.frames) })).sort((left, right) => right.score - left.score);
          const best = candidates[0]; const second = candidates.find((item) => item.template.agentId !== best?.template.agentId);
          if (best?.score >= DETECTION_THRESHOLD && (!second || best.score - second.score >= DETECTION_MARGIN)) trigger('wake-word', best.template);
        }
      };
      runtime.source.connect(runtime.processor); runtime.processor.connect(mute); mute.connect(runtime.context.destination); try { await runtime.context.resume(); } catch {}
      emit(); return runtime.stream;
    }
    async function enable() { runtime.enabled = true; await connectLocal(); emit(); return state(); }
    function disable() { runtime.enabled = false; runtime.commandActive = false; disconnectDetector(); emit(); return state(); }
    async function trainSample(durationMs = 2500) {
      await connectLocal(); if (runtime.training) throw new Error('A wake-phrase sample is already recording.');
      const result = await new Promise((resolve) => { runtime.training = { frames: [], endsAt: Date.now() + Math.min(4000, Math.max(1000, durationMs)), resolve }; emit(); });
      return normalize(result);
    }
    async function pushToTalkStart() {
      if (!runtime.settings.pushToTalk || runtime.commandActive) return state();
      await connectLocal(); const stream = takeStream(); onTrigger?.({ reason: 'push-to-talk', agentId: runtime.settings.agentId, phrase: 'push-to-talk', stream, preRollBlob: null, preRollDurationMs: 0 }); return state();
    }
    function finishCommand() { runtime.commandActive = false; runtime.ring = []; runtime.recent = []; if (runtime.settings.alwaysListening && runtime.enabled) void connectLocal().catch((error) => onError?.(error)); emit(); }
    return { state, setSettings, setTemplates, enable, disable, trainSample, pushToTalkStart, finishCommand, takeStream };
  }

  window.HexiGridWakeWord = Object.freeze({ createWakeWordEngine, createFeatureExtractor, frameFeatures, normalizeFeatures: normalize, diagnostics: Object.freeze({ detector: DETECTOR, threshold: DETECTION_THRESHOLD, margin: DETECTION_MARGIN, similarity, scoreCandidate }) });
})();
