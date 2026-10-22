import { spawn } from 'node:child_process';

// Windows' installed SAPI voices synthesize into a memory stream. Text enters
// through stdin, never the command line, and neither text nor audio is logged.
const SAPI_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$text = [Console]::In.ReadToEnd()',
  '$stream = New-Object System.IO.MemoryStream',
  '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try {',
  '  $speaker.SetOutputToWaveStream($stream)',
  '  $speaker.Speak($text)',
  '  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))',
  '} finally { $speaker.Dispose(); $stream.Dispose() }'
].join('; ');

const MAX_TEXT = 240;
const MAX_OUTPUT = 4 * 1024 * 1024;

export async function synthesizeLocalSpeech(text, { platform = process.platform, spawnProcess = spawn, signal } = {}) {
  const input = String(text || '').trim();
  if (!input || input.length > MAX_TEXT) throw new Error('Local speech needs 1–240 characters of text.');
  if (platform !== 'win32') throw new Error('This local speech adapter requires Windows SAPI.');
  if (signal?.aborted) throw new Error('Local speech was cancelled.');
  const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SAPI_SCRIPT], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal
  });
  const output = [];
  let length = 0;
  let finished = false;
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (part) => {
      length += part.length;
      if (length > MAX_OUTPUT) { child.kill(); return; }
      output.push(part);
    });
    // Never expose PowerShell's stderr: it may echo input or machine details.
    child.stderr.resume();
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (length > MAX_OUTPUT || code !== 0) return reject(new Error('Local speech generation failed.'));
      const encoded = Buffer.concat(output).toString('ascii').trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return reject(new Error('Local speech returned invalid audio.'));
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length < 44 || bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WAVE') return reject(new Error('Local speech returned invalid WAV audio.'));
      resolve({ bytes, mimeType: 'audio/wav' });
    });
  });
  child.stdin.end(input);
  return completion;
}
