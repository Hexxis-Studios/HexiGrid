import { execFile as defaultExecFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureSpeechVadModel } from './speech-vad-model.mjs';

const execFileAsync = promisify(defaultExecFile);
const MODELS = new Set(['tiny', 'base']);
const MAX_TURN_CHUNKS = 120;
const MAX_TURN_BYTES = 8 * 1024 * 1024;
const MAX_TURN_DURATION_MS = 120_000;
const LANGUAGES = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 20_000); }
function extension(mimeType) { return ({ 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/wav': '.wav' }[String(mimeType)] || '.bin'); }
function quoteConcat(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function findExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try { await fs.access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return '';
}

export function normalizeTranscriptionSettings(value = {}) {
  return {
    enabled: value.enabled === true,
    memoryOnly: value.memoryOnly === true,
    model: MODELS.has(value.model) ? value.model : 'tiny',
    language: LANGUAGES.test(String(value.language || '')) ? String(value.language) : 'en',
    lastTranscriptAt: typeof value.lastTranscriptAt === 'string' ? value.lastTranscriptAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 500) : ''
  };
}

export class LocalTranscriber {
  constructor({ root, modelRoot, runner = async (command, args, options = {}) => execFileAsync(command, args, { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options }), ffmpegPath = '', whisperPath = '', vadPath = '', vadModelProvider = ensureSpeechVadModel, finalDelayMs = 1_500 } = {}) {
    this.root = root || path.join(os.homedir(), '.hexigrid', 'transcription');
    this.modelRoot = modelRoot || this.root;
    this.runner = runner;
    this.ffmpegPath = ffmpegPath;
    this.whisperPath = whisperPath;
    this.vadPath = vadPath;
    this.vadModelProvider = vadModelProvider;
    this.vadModel = null;
    this.finalDelayMs = Math.max(10, Math.min(5_000, Number(finalDelayMs) || 1_500));
    this.buffers = new Map();
    this.workRoot = path.join(this.root, 'call-temp');
    this.prepared = null;
  }

  prepare() {
    this.prepared ||= this.preparePrivateWorkRoot();
    return this.prepared;
  }

  async preparePrivateWorkRoot() {
    await fs.mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      const { stdout } = await this.runner(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
      const sid = String(stdout).match(/S-1-(?:\d+-)+\d+/)?.[0];
      if (!sid) throw new Error('Could not establish private transcription permissions.');
      await this.runner(path.join(system32, 'icacls.exe'), [this.workRoot, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
    } else await fs.chmod(this.workRoot, 0o700);
    const resolvedRoot = await fs.realpath(this.workRoot);
    for (const entry of await fs.readdir(this.workRoot, { withFileTypes: true })) {
      if (!/^segment-[A-Za-z0-9_-]+$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.resolve(this.workRoot, entry.name);
      const resolved = await fs.realpath(candidate);
      if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Unsafe transcription work directory.');
      await fs.rm(candidate, { recursive: true, force: true });
    }
  }

  configure(connection, input = {}) {
    // Pending audio belongs to the previous recognition/privacy configuration.
    this.clear(connection.id);
    connection.transcription = normalizeTranscriptionSettings({ ...connection.transcription, ...input, lastError: '' });
    return { ...connection.transcription };
  }

  clear(linkId) {
    const entry = this.buffers.get(String(linkId));
    if (entry?.finalTimer) clearTimeout(entry.finalTimer);
    entry?.controller?.abort();
    this.buffers.delete(String(linkId));
  }

  async resolveRuntime(model) {
    const whisper = this.whisperPath || await findExecutable([
      process.env.HEXIGRID_WHISPER_CLI,
      path.join(this.modelRoot, 'engine', 'whisper-cli.exe'),
      path.join(this.modelRoot, 'engine', 'Release', 'whisper-cli.exe'),
      path.join(this.modelRoot, 'engine', 'whisper-cli')
    ]);
    const ffmpeg = this.ffmpegPath || await findExecutable([
      process.env.HEXIGRID_FFMPEG,
      'C:\\ffmpeg\\ffmpeg-7.1.1-full_build\\bin\\ffmpeg.exe',
      path.join(this.modelRoot, 'engine', 'ffmpeg.exe')
    ]);
    const modelPath = path.join(this.modelRoot, 'models', `ggml-${model}.bin`);
    try { await fs.access(modelPath); } catch { throw new Error(`Local transcription model '${model}' is not installed.`); }
    if (!whisper) throw new Error('The local whisper.cpp engine is not installed.');
    if (!ffmpeg) throw new Error('FFmpeg is required for local microphone transcription.');
    const vad = this.vadPath || await findExecutable([
      path.join(path.dirname(whisper), process.platform === 'win32' ? 'whisper-vad-speech-segments.exe' : 'whisper-vad-speech-segments')
    ]);
    if (!vad) throw new Error('Update the local whisper.cpp engine to include its speech detector. Transcripts are blocked until it is available.');
    this.vadModel ||= this.vadModelProvider(this.modelRoot).catch(error => { this.vadModel = null; throw error; });
    return { whisper, ffmpeg, modelPath, vad, vadModelPath: await this.vadModel };
  }

  enqueue(connection, segment, emitEvent, { activeCall = false } = {}) {
    const configured = normalizeTranscriptionSettings(connection.transcription);
    connection.transcription = configured;
    // An accepted call permits session-only local transcription without
    // changing the Link's saved enabled setting. It never overrides an
    // explicit memory-only choice because this CLI engine writes temporary files.
    const settings = activeCall ? { ...configured, enabled: true } : configured;
    if (!settings.enabled) return { queued: false, reason: 'disabled' };
    if (settings.memoryOnly) return { queued: false, reason: 'memory-only-engine-unavailable' };
    const linkId = String(connection.id);
    const entry = this.buffers.get(linkId) || { chunks: [], chain: Promise.resolve(), finalTimer: null, partialText: '', controller: new AbortController() };
    // The owner meter marks silence without stopping the live microphone stream.
    // Older senders without this optional signal retain transport-gap completion.
    const silent = segment.speechActive === false;
    if (silent && !entry.chunks.length && !entry.turnRejected) return { queued: false, reason: 'silence' };
    if (!entry.turnRejected) {
      const bytes = Buffer.byteLength(String(segment.data || ''), 'base64');
      const duration = Math.max(100, Math.min(2500, Number(segment.durationMs) || 1000));
      if (entry.chunks.length >= MAX_TURN_CHUNKS || (entry.bufferBytes || 0) + bytes > MAX_TURN_BYTES || (entry.bufferDuration || 0) + duration > MAX_TURN_DURATION_MS) {
        entry.turnRejected = true; entry.warningReported = true; entry.chunks = [];
        const turn = entry.turnSequence || 0;
        if (entry.pendingPartial?.turn === turn) entry.pendingPartial = null;
        if (entry.activeJob && !entry.activeJob.final && entry.activeJob.turn === turn) entry.activeJob.controller.abort();
        connection.transcription.lastError = 'This spoken turn exceeded the local recognition limit (2 minutes, 120 segments or 8 MiB). It was not recognized in full. Pause, then use shorter turns.';
        emitEvent({ type: 'speech.transcription.error', text: connection.transcription.lastError, metadata: { source: 'owner-microphone', reason: 'utterance-limit' } });
      } else {
        entry.chunks.push({ mimeType: segment.mimeType, data: segment.data, sequence: segment.sequence });
        entry.bufferBytes = (entry.bufferBytes || 0) + bytes; entry.bufferDuration = (entry.bufferDuration || 0) + duration;
      }
    }
    if (!silent) {
      if (entry.finalTimer) clearTimeout(entry.finalTimer);
      if (!entry.turnRejected && entry.chunks.length >= 2 && entry.chunks.length % 2 === 0) this.schedule(entry, connection, entry.chunks.slice(-6), false, emitEvent, settings);
      entry.finalTimer = setTimeout(() => {
        entry.finalTimer = null;
        const finalChunks = entry.chunks.splice(0);
        entry.bufferBytes = 0; entry.bufferDuration = 0;
        if (entry.turnRejected) { entry.turnRejected = false; entry.turnSequence = (entry.turnSequence || 0) + 1; }
        else this.schedule(entry, connection, finalChunks, true, emitEvent, settings);
      }, this.finalDelayMs);
      entry.finalTimer.unref?.();
    }
    this.buffers.set(linkId, entry);
    return { queued: !entry.turnRejected, ...(entry.turnRejected ? { reason: 'utterance-limit' } : {}), sequence: segment.sequence, model: settings.model, language: settings.language };
  }

  schedule(entry, connection, chunks, final, emitEvent, settingsValue = connection.transcription) {
    if (!chunks.length || entry.controller.signal.aborted) return;
    entry.pendingFinals ||= [];
    entry.turnSequence ||= 0;
    const job = { chunks, final, emitEvent, turn: entry.turnSequence, settings: normalizeTranscriptionSettings(settingsValue) };
    if (final) {
      if (entry.pendingPartial?.turn === job.turn) entry.pendingPartial = null;
      if (entry.activeJob && !entry.activeJob.final && entry.activeJob.turn === job.turn) entry.activeJob.controller.abort();
      entry.turnSequence += 1;
      if (entry.pendingFinals.length >= 2) {
        entry.warningReported = true;
        connection.transcription.lastError = 'Local recognition is behind. This turn was not recognized; wait for queued turns before speaking again.';
        emitEvent({ type: 'speech.transcription.error', text: connection.transcription.lastError, metadata: { source: 'owner-microphone', reason: 'recognition-backlog' } });
        return;
      }
      entry.pendingFinals.push(job);
    } else entry.pendingPartial = job; // Only the freshest preview is useful.
    if (entry.processing) return;
    entry.processing = true;
    entry.chain = (async () => {
      try {
        while (!entry.controller.signal.aborted) {
          const current = entry.pendingFinals.shift() || entry.pendingPartial;
          if (!current) break;
          if (current === entry.pendingPartial) entry.pendingPartial = null;
          current.controller = new AbortController(); entry.activeJob = current;
          const signal = AbortSignal.any([entry.controller.signal, current.controller.signal]);
          try {
            const text = await this.transcribe(current.chunks, current.settings, { signal });
            if (signal.aborted || !text || (!current.final && text === entry.partialText)) continue;
            entry.partialText = current.final ? '' : text;
            connection.transcription.lastTranscriptAt = new Date().toISOString();
            // Incomplete-turn warnings remain visible until a new configuration or capture session.
            if (!entry.warningReported) connection.transcription.lastError = '';
            current.emitEvent({ type: current.final ? 'speech.transcript.final' : 'speech.transcript.partial', text,
              metadata: { final: current.final, model: current.settings.model, language: current.settings.language, source: 'owner-microphone' } });
          } catch (error) {
            if (!signal.aborted) {
              connection.transcription.lastError = String(error.message || error).replaceAll(this.root, '[local transcription]').slice(0, 500);
              current.emitEvent({ type: 'speech.transcription.error', text: `Voice-to-text could not start: ${connection.transcription.lastError}`, metadata: { source: 'owner-microphone', reason: 'local-engine-unavailable' } });
            }
          } finally { if (entry.activeJob === current) entry.activeJob = null; }
        }
      } finally { entry.processing = false; }
    })();
  }

  async transcribe(chunks, settingsValue, { signal } = {}) {
    const settings = normalizeTranscriptionSettings(settingsValue);
    const runtime = await this.resolveRuntime(settings.model);
    await this.prepare();
    const work = await fs.mkdtemp(path.join(this.workRoot, 'segment-'));
    try {
      if (signal?.aborted) return '';
      const inputs = [];
      for (const [index, chunk] of chunks.entries()) {
        const target = path.join(work, `segment-${String(index).padStart(3, '0')}${extension(chunk.mimeType)}`);
        await fs.writeFile(target, Buffer.from(String(chunk.data), 'base64'), { mode: 0o600 }); inputs.push(target);
      }
      const concat = path.join(work, 'segments.txt'); const wav = path.join(work, 'speech.wav'); const outputBase = path.join(work, 'transcript');
      await fs.writeFile(concat, inputs.map((input) => `file ${quoteConcat(input)}`).join('\n'), { mode: 0o600 });
      await this.runner(runtime.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-ar', '16000', '-ac', '1', wav], { signal });
      if (signal?.aborted) return '';
      const detected = await this.runner(runtime.vad, ['-vm', runtime.vadModelPath, '-f', wav, '-vt', '0.6', '-vspd', '100', '-np'], { signal });
      if (signal?.aborted) return '';
      const speechCount = String(detected.stdout || '').match(/^Detected (\d+) speech segments:/m);
      if (!speechCount) throw new Error('The local speech detector returned an invalid result. No transcript was delivered.');
      if (Number(speechCount[1]) === 0) return '';
      // VAD admits or drops the whole utterance. Keep its complete audio for
      // decoding so short words and negations are never cut out by the gate.
      await this.runner(runtime.whisper, ['-m', runtime.modelPath, '-f', wav, '-l', settings.language, '-sns', '-nt', '-np', '-otxt', '-of', outputBase], { signal });
      if (signal?.aborted) return '';
      return cleanText(await fs.readFile(`${outputBase}.txt`, 'utf8'));
    } finally { await fs.rm(work, { recursive: true, force: true }); }
  }
}
