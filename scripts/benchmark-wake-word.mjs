import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'public', 'wake-word.js');
const wakePhrase = 'Hey ExampleAgent';
const negativeText = [
  'The weather should remain calm through the afternoon.',
  'Please put the blue folder beside the kitchen calendar.',
  'A small lantern was glowing near the end of the hallway.',
  'Tomorrow we can review the schedule and choose a better time.',
  'The package arrived safely and the label was easy to read.',
  'Several neighbors planted flowers along the walking path.',
  'Remember to close the window before leaving the room.',
  'This conversation contains ordinary words but not the activation phrase.',
].join(' ');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [name, inline] = item.slice(2).split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags.set(name, argv[++index]);
    else flags.set(name, true);
  }
  return {
    soakMinutes: Math.max(0, Math.min(60, Number(flags.get('soak-minutes') || 0))),
    soakOnly: Boolean(flags.get('soak-only')),
    json: Boolean(flags.get('json')),
  };
}

async function loadDetector() {
  const source = await readFile(sourcePath, 'utf8');
  const context = { window: {}, Blob, ArrayBuffer, DataView, Float32Array, Math, Date, Object, String, Number, console, setTimeout, clearTimeout };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.window.HexiGridWakeWord;
}

function readPcmWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Fixture is not a RIFF/WAVE file.');
  let offset = 12; let format = null; let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4); const size = buffer.readUInt32LE(offset + 4); const start = offset + 8;
    if (id === 'fmt ') format = { encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14) };
    if (id === 'data') data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16) throw new Error('Fixture must be mono 16-bit PCM.');
  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = data.readInt16LE(index * 2) / 32768;
  return { samples, sampleRate: format.sampleRate };
}

function powershell(script, environment = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...environment } });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'PowerShell command failed.').trim());
  return String(result.stdout || '').trim();
}

function installedVoices() {
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | ForEach-Object { $_.VoiceInfo.Name }`;
  return [...new Set(powershell(script).split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function synthesize(output, voice, rate, text) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice($env:HEX_WAKE_VOICE); $s.Rate=[int]$env:HEX_WAKE_RATE; $s.SetOutputToWaveFile($env:HEX_WAKE_OUTPUT); $s.Speak($env:HEX_WAKE_TEXT); $s.Dispose()`;
  powershell(script, { HEX_WAKE_VOICE: voice, HEX_WAKE_RATE: String(rate), HEX_WAKE_TEXT: text, HEX_WAKE_OUTPUT: output });
}

function seededNoise(length, seed = 0x5eed) {
  let state = seed >>> 0; const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) { state = (1664525 * state + 1013904223) >>> 0; output[index] = (state / 0xffffffff) * 2 - 1; }
  return output;
}

function addNoise(samples, snrDb, seed) {
  let signal = 0; for (const value of samples) signal += value * value; signal = Math.sqrt(signal / Math.max(1, samples.length));
  const noise = seededNoise(samples.length, seed); let noiseRms = 0; for (const value of noise) noiseRms += value * value; noiseRms = Math.sqrt(noiseRms / Math.max(1, noise.length));
  const gain = signal / Math.max(1e-9, noiseRms * (10 ** (snrDb / 20))); const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) output[index] = Math.max(-1, Math.min(1, samples[index] + noise[index] * gain));
  return output;
}

function padAudio(samples, sampleRate, beforeMs = 350, afterMs = 650) {
  const before = Math.round(sampleRate * beforeMs / 1000); const after = Math.round(sampleRate * afterMs / 1000); const output = new Float32Array(before + samples.length + after);
  output.set(samples, before); return output;
}

function simulateDistance(samples, sampleRate, meters) {
  if (meters <= 1) return samples;
  const output = new Float32Array(samples.length); const attenuation = 1 / Math.max(1, meters * 0.75); const delay = Math.round(sampleRate * 0.07); const echo = 0.16 / meters;
  for (let index = 0; index < samples.length; index += 1) output[index] = Math.max(-1, Math.min(1, samples[index] * attenuation + (index >= delay ? samples[index - delay] * echo : 0)));
  return output;
}

function scan(detector, features, templates, { tickFrames = 4, cooldownFrames = 28 } = {}) {
  let hits = 0; let cooldown = 0; let bestScore = 0;
  for (let end = 8; end <= features.length; end += tickFrames) {
    if (cooldown > 0) { cooldown -= tickFrames; continue; }
    const scores = templates.map((template) => detector.scoreCandidate(features.slice(0, end), template));
    const score = Math.max(0, ...scores); bestScore = Math.max(bestScore, score);
    if (score >= detector.threshold) { hits += 1; cooldown = cooldownFrames; }
  }
  return { hits, bestScore };
}

function scanRepeated(detector, pattern, templates, totalFrames, { tickFrames = 4, cooldownFrames = 28 } = {}) {
  let hits = 0; let cooldown = 0; let bestScore = 0; const recent = []; const maxTemplate = Math.max(...templates.map((item) => item.length)); const keep = Math.ceil(maxTemplate * 1.3) + tickFrames;
  for (let offset = 0; offset < totalFrames; offset += tickFrames) {
    for (let step = 0; step < tickFrames; step += 1) recent.push(pattern[(offset + step) % pattern.length]);
    if (recent.length > keep) recent.splice(0, recent.length - keep);
    if (cooldown > 0) { cooldown -= tickFrames; continue; }
    const score = Math.max(0, ...templates.map((template) => detector.scoreCandidate(recent, template))); bestScore = Math.max(bestScore, score);
    if (score >= detector.threshold) { hits += 1; cooldown = cooldownFrames; }
  }
  return { hits, bestScore };
}

function activeSocketsForCurrentProcess() {
  if (process.platform !== 'win32') return [];
  const script = `$pidValue=[int]$env:HEX_WAKE_PID; $tcp=Get-NetTCPConnection -OwningProcess $pidValue -ErrorAction SilentlyContinue | Select-Object -ExpandProperty RemoteAddress; $udp=Get-NetUDPEndpoint -OwningProcess $pidValue -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress; @($tcp)+@($udp)`;
  return powershell(script, { HEX_WAKE_PID: String(process.pid) }).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function run() {
  const options = parseArgs(process.argv.slice(2)); const api = await loadDetector(); const detector = api.diagnostics;
  const voices = options.soakOnly ? [] : installedVoices().slice(0, 3);
  if (!options.soakOnly && voices.length < 2) throw new Error('The benchmark needs at least two installed offline English voices.');
  const directory = await mkdtemp(path.join(tmpdir(), 'hexigrid-wake-'));
  const started = performance.now(); const cpuStarted = process.cpuUsage(); let peakRss = process.memoryUsage().rss;
  try {
    let cleanTotal = 0; let cleanDetected = 0; let noisyTotal = 0; let noisyDetected = 0; let negativeHours = 0; let falseAccepts = 0; let soakTemplate = null; const perVoice = [];
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex += 1) {
      const voice = voices[voiceIndex]; const templates = [];
      for (const rate of [-1, 0, 1]) {
        const file = path.join(directory, `train-${voiceIndex}-${rate}.wav`); synthesize(file, voice, rate, wakePhrase);
        const wav = readPcmWav(await readFile(file)); templates.push(api.normalizeFeatures(api.frameFeatures(padAudio(wav.samples, wav.sampleRate), 1024, wav.sampleRate)));
      }
      soakTemplate ||= templates[0];
      const voiceMetrics = { voice, clean: [], noisy: [], routing: null };
      for (const rate of [-2, -1, 0, 1, 2]) {
        const file = path.join(directory, `positive-${voiceIndex}-${rate}.wav`); synthesize(file, voice, rate, wakePhrase);
        const wav = readPcmWav(await readFile(file)); const padded = padAudio(wav.samples, wav.sampleRate);
        for (const meters of [1, 3]) {
          const clean = api.frameFeatures(simulateDistance(padded, wav.sampleRate, meters), 1024, wav.sampleRate); const cleanResult = scan(detector, clean, templates);
          cleanTotal += 1; cleanDetected += cleanResult.hits > 0 ? 1 : 0; voiceMetrics.clean.push({ rate, meters, ...cleanResult });
        }
        for (const snrDb of [20, 10]) {
          const distant = simulateDistance(padded, wav.sampleRate, 2); const noisy = api.frameFeatures(addNoise(distant, snrDb, 1000 + voiceIndex * 100 + rate * 3 + snrDb), 1024, wav.sampleRate); const noisyResult = scan(detector, noisy, templates);
          noisyTotal += 1; noisyDetected += noisyResult.hits > 0 ? 1 : 0; voiceMetrics.noisy.push({ rate, snrDb, ...noisyResult });
        }
      }
      const wrongFile = path.join(directory, `wrong-agent-${voiceIndex}.wav`); synthesize(wrongFile, voice, 0, 'Hey Hexi'); const wrongWav = readPcmWav(await readFile(wrongFile));
      const wrongTemplate = api.normalizeFeatures(api.frameFeatures(padAudio(wrongWav.samples, wrongWav.sampleRate), 1024, wrongWav.sampleRate));
      const routingFile = path.join(directory, `routing-${voiceIndex}.wav`); synthesize(routingFile, voice, 0, wakePhrase); const routingWav = readPcmWav(await readFile(routingFile)); const routingFeatures = api.frameFeatures(padAudio(routingWav.samples, routingWav.sampleRate), 1024, routingWav.sampleRate);
      const correctScore = Math.max(...templates.map((template) => detector.scoreCandidate(routingFeatures, template))); const wrongScore = detector.scoreCandidate(routingFeatures, wrongTemplate);
      voiceMetrics.routing = { correctScore, wrongScore, margin: correctScore - wrongScore, passed: correctScore >= detector.threshold && correctScore - wrongScore >= detector.margin };
      const negativeFile = path.join(directory, `negative-${voiceIndex}.wav`); synthesize(negativeFile, voice, 0, negativeText);
      const negativeWav = readPcmWav(await readFile(negativeFile)); const negativeFeatures = api.frameFeatures(padAudio(negativeWav.samples, negativeWav.sampleRate, 0, 500), 1024, negativeWav.sampleRate);
      const hourFrames = Math.floor(3600 * negativeWav.sampleRate / 512); const negativeResult = scanRepeated(detector, negativeFeatures, templates, hourFrames);
      falseAccepts += negativeResult.hits; negativeHours += 1; voiceMetrics.falseAcceptsPerHour = negativeResult.hits; voiceMetrics.negativeBestScore = negativeResult.bestScore; perVoice.push(voiceMetrics);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    if (options.soakOnly) {
      const synthetic = new Float32Array(48000);
      for (let index = 0; index < synthetic.length; index += 1) synthetic[index] = Math.sin(2 * Math.PI * 440 * index / 48000) * 0.08;
      soakTemplate = api.normalizeFeatures(api.frameFeatures(synthetic, 1024, 48000));
    }

    global.gc?.();
    const soakStarted = performance.now(); const soakCpu = process.cpuUsage(); const socketFindings = new Set(); let soakPeakRss = process.memoryUsage().rss; let nextSocketCheck = 0;
    const quietPcm = seededNoise(2048, 0x1d1e); for (let index = 0; index < quietPcm.length; index += 1) quietPcm[index] *= 0.002;
    const soakRecent = []; const soakExtractor = api.createFeatureExtractor(48000, 1024);
    const soakDeadline = Date.now() + options.soakMinutes * 60_000;
    while (Date.now() < soakDeadline) {
      if (Date.now() >= nextSocketCheck) { for (const socket of activeSocketsForCurrentProcess()) socketFindings.add(socket); nextSocketCheck = Date.now() + 5000; }
      for (let callback = 0; callback < 3; callback += 1) soakRecent.push(...soakExtractor.push(quietPcm));
      if (soakRecent.length > 240) soakRecent.splice(0, soakRecent.length - 240);
      detector.scoreCandidate(soakRecent, soakTemplate); soakPeakRss = Math.max(soakPeakRss, process.memoryUsage().rss);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const soakWallMs = performance.now() - soakStarted; const soakCpuUsage = process.cpuUsage(soakCpu); const soakCpuPercent = soakWallMs ? ((soakCpuUsage.user + soakCpuUsage.system) / 1000 / soakWallMs) * 100 : null;
    const cleanScores = perVoice.flatMap((item) => item.clean.map((entry) => entry.bestScore)).sort((left, right) => left - right);
    const cleanMedian = cleanScores.length % 2 ? cleanScores[(cleanScores.length - 1) / 2] : (cleanScores[cleanScores.length / 2 - 1] + cleanScores[cleanScores.length / 2]) / 2;
    const cpu = process.cpuUsage(cpuStarted); const report = {
      detector: detector.detector,
      generatedAt: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      cpuModel: powershell(`(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)`),
      voices,
      clean: { detected: cleanDetected, total: cleanTotal, rate: cleanDetected / cleanTotal },
      cleanScoreDistribution: { min: cleanScores[0] ?? null, median: cleanMedian ?? null, withinPoint01OfThreshold: cleanScores.filter((score) => score >= detector.threshold && score < detector.threshold + 0.01).length },
      noisy: { detected: noisyDetected, total: noisyTotal, rate: noisyDetected / noisyTotal },
      falseAccepts: { count: falseAccepts, hours: negativeHours, perHour: falseAccepts / negativeHours },
      resources: { benchmarkWallMs: Math.round(performance.now() - started), benchmarkCpuMs: Math.round((cpu.user + cpu.system) / 1000), peakRssMiB: Number((peakRss / 1048576).toFixed(1)), soakMinutes: options.soakMinutes, soakCpuPercent: soakCpuPercent === null ? null : Number(soakCpuPercent.toFixed(2)), soakPeakRssMiB: Number((soakPeakRss / 1048576).toFixed(1)) },
      egress: { observedSockets: [...socketFindings], passed: socketFindings.size === 0 },
      thresholds: { cleanDetectionRate: 0.95, falseAcceptsPerHour: 1, idleCpuPercent: 5 },
      limitations: { syntheticNoiseIsDiagnosticOnly: true, syntheticNoiseSnrDb: [20, 10], note: 'Direct synthetic noise bypasses browser WebRTC noise suppression; failures must be documented and push-to-talk remains available.' },
      passed: (options.soakOnly || (cleanDetected / cleanTotal >= 0.95 && falseAccepts / negativeHours <= 1 && perVoice.every((item) => item.routing?.passed))) && (!options.soakMinutes || (socketFindings.size === 0 && soakCpuPercent < 5)),
      perVoice,
    };
    process.stdout.write(`${JSON.stringify(report, null, options.json ? 0 : 2)}\n`);
    if (!report.passed) fail('Wake-word benchmark did not meet every measured acceptance threshold.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

run().catch((error) => fail(error.stack || error.message));
