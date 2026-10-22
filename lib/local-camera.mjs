import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const fail = (message, code, status = 503) => Object.assign(new Error(message), { code, status });

// FFmpeg is an optional, installed local backend. No shell, files, network input,
// or agent-supplied command/device arguments are used.
export function videoDevices(stderr) {
  return [...String(stderr).matchAll(/"([^"\r\n]+)"\s+\(video\)/g)].map(match => match[1]);
}

export async function captureLocalCamera({ signal, runner = execute, platform = process.platform,
  executable = process.env.HEXIGRID_FFMPEG || 'ffmpeg', device = process.env.HEXIGRID_CAMERA_DEVICE || '' } = {}) {
  if (platform !== 'win32') throw fail('Unattended camera capture currently requires Windows or an active browser camera.', 'CAMERA_BACKEND_UNAVAILABLE', 409);
  const options = { windowsHide: true, shell: false, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'buffer', signal };
  let listing;
  try { listing = await runner(executable, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], options); }
  catch (error) {
    if (signal?.aborted) throw fail('Camera access was stopped.', 'CAMERA_STOPPED', 403);
    if (!error.stderr) throw fail('Install local FFmpeg or start the browser camera to enable camera capture.', 'CAMERA_BACKEND_UNAVAILABLE');
    listing = error; // Device enumeration deliberately exits nonzero.
  }
  const devices = videoDevices(listing.stderr);
  const selected = device || devices[0];
  if (!selected || !devices.includes(selected)) throw fail('No selected local camera is available. Check Windows camera permissions and connected devices.', 'CAMERA_DEVICE_UNAVAILABLE');
  let bytes;
  try {
    const result = await runner(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'dshow',
      '-i', `video=${selected}`, '-an', '-frames:v', '1', '-vf', 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2',
      '-q:v', '6', '-vcodec', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], options);
    bytes = Buffer.from(result.stdout);
  } catch {
    if (signal?.aborted) throw fail('Camera access was stopped.', 'CAMERA_STOPPED', 403);
    throw fail('The local camera could not capture a frame. Check Windows privacy settings or whether another app is using it.', 'CAMERA_CAPTURE_FAILED');
  }
  if (bytes.length < 4 || bytes.length > 220 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw fail('The local camera returned an invalid or oversized JPEG frame.', 'CAMERA_FRAME_INVALID');
  }
  return { mimeType: 'image/jpeg', data: bytes.toString('base64'), width: 640, height: 480 };
}
