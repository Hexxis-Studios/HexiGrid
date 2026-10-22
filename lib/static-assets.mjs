import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATIC_ASSETS = new Map([
  ['/codex-deliveries-ui.js', ['codex-deliveries-ui.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/device-preferences.js', ['device-preferences.js', 'text/javascript; charset=utf-8']],
  ['/local-release-ui.js', ['local-release-ui.js', 'text/javascript; charset=utf-8']],
  ['/view-renderers.js', ['view-renderers.js', 'text/javascript; charset=utf-8']],
  ['/agent-interface.js', ['agent-interface.js', 'text/javascript; charset=utf-8']],
  ['/agent-interface.css', ['agent-interface.css', 'text/css; charset=utf-8']],
  ['/incoming-voice-call.js', ['incoming-voice-call.js', 'text/javascript; charset=utf-8']],
  ['/incoming-voice-call.css', ['incoming-voice-call.css', 'text/css; charset=utf-8']],
  ['/providers.js', ['providers.js', 'text/javascript; charset=utf-8']],
  ['/provider-limits.mjs', ['provider-limits.mjs', 'text/javascript; charset=utf-8']],
  ['/icons.js', ['icons.js', 'text/javascript; charset=utf-8']],
  ['/guide-content.js', ['guide-content.js', 'text/javascript; charset=utf-8']],
  ['/help/navigation.webp', ['help/navigation.webp', 'image/webp']],
  ['/help/memory.webp', ['help/memory.webp', 'image/webp']],
  ['/help/workspace.webp', ['help/workspace.webp', 'image/webp']],
  ['/help/agent-choices.webp', ['help/agent-choices.webp', 'image/webp']],
  ['/help/agent-invitation.webp', ['help/agent-invitation.webp', 'image/webp']],
  ['/help/avatars.webp', ['help/avatars.webp', 'image/webp']],
  ['/help/backup-controls.webp', ['help/backup-controls.webp', 'image/webp']],
  ['/help/backup-passphrase.webp', ['help/backup-passphrase.webp', 'image/webp']],
  ['/help/backup-schedule.webp', ['help/backup-schedule.webp', 'image/webp']],
  ['/help/codex-routing.webp', ['help/codex-routing.webp', 'image/webp']],
  ['/help/computer-access.webp', ['help/computer-access.webp', 'image/webp']],
  ['/help/local-job.webp', ['help/local-job.webp', 'image/webp']],
  ['/help/mcp-server.webp', ['help/mcp-server.webp', 'image/webp']],
  ['/help/memory-fact.webp', ['help/memory-fact.webp', 'image/webp']],
  ['/help/memory-sharing.webp', ['help/memory-sharing.webp', 'image/webp']],
  ['/help/provider-api.webp', ['help/provider-api.webp', 'image/webp']],
  ['/help/provider-local.webp', ['help/provider-local.webp', 'image/webp']],
  ['/help/skill-editor.webp', ['help/skill-editor.webp', 'image/webp']],
  ['/help/task-schedule.webp', ['help/task-schedule.webp', 'image/webp']],
  ['/help/vault-plugin.webp', ['help/vault-plugin.webp', 'image/webp']],
  ['/help/agent-api.webp', ['help/agent-api.webp', 'image/webp']],
  ['/setup-prompts.js', ['setup-prompts.js', 'text/javascript; charset=utf-8']],
  ['/setup-prompt-ui.js', ['setup-prompt-ui.js', 'text/javascript; charset=utf-8']],
  ['/agent-ui.js', ['agent-ui.js', 'text/javascript; charset=utf-8']],
  ['/chat-ui.js', ['chat-ui.js', 'text/javascript; charset=utf-8']],
  ['/communication-ui.js', ['communication-ui.js', 'text/javascript; charset=utf-8']],
  ['/workspace-ui.js', ['workspace-ui.js', 'text/javascript; charset=utf-8']],
  ['/guide-ui.js', ['guide-ui.js', 'text/javascript; charset=utf-8']],
  ['/harnesses.js', ['harnesses.js', 'text/javascript; charset=utf-8']],
  ['/control-shell.js', ['control-shell.js', 'text/javascript; charset=utf-8']],
  ['/task-ui.js', ['task-ui.js', 'text/javascript; charset=utf-8']],
  ['/harness-job-ui.js', ['harness-job-ui.js', 'text/javascript; charset=utf-8']],
  ['/plugin-ui.js', ['plugin-ui.js', 'text/javascript; charset=utf-8']],
  ['/hexikeys-ui.js', ['hexikeys-ui.js', 'text/javascript; charset=utf-8']],
  ['/backup-ui.js', ['backup-ui.js', 'text/javascript; charset=utf-8']],
  ['/auth-ui.js', ['auth-ui.js', 'text/javascript; charset=utf-8']],
  ['/live-voice.js', ['live-voice.js', 'text/javascript; charset=utf-8']],
  ['/live-recording.js', ['live-recording.js', 'text/javascript; charset=utf-8']],
  ['/live-generated-voice.js', ['live-generated-voice.js', 'text/javascript; charset=utf-8']],
  ['/live-call.js', ['live-call.js', 'text/javascript; charset=utf-8']],
  ['/hexispace-embed-mode.js', ['hexispace-embed-mode.js', 'text/javascript; charset=utf-8']],
  ['/hexispace-embed.js', ['hexispace-embed.js', 'text/javascript; charset=utf-8']],
  ['/live-realtime.js', ['live-realtime.js', 'text/javascript; charset=utf-8']],
  ['/agent-mail.js', ['agent-mail.js', 'text/javascript; charset=utf-8']],
  ['/agent-link.js', ['agent-link.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-connect.js', ['agent-link-connect.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-browser-client.js', ['agent-link-browser-client.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-actions.js', ['agent-link-actions.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-relay-client.js', ['agent-link-relay-client.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-connect.css', ['agent-link-connect.css', 'text/css; charset=utf-8']],
  ['/agent-link-media.css', ['agent-link-media.css', 'text/css; charset=utf-8']],
  ['/hexispace-approve.js', ['hexispace-approve.js', 'text/javascript; charset=utf-8']],
  ['/avatar-viewer.js', ['avatar-viewer.js', 'text/javascript; charset=utf-8']],
  ['/avatar-stage.js', ['avatar-stage.js', 'text/javascript; charset=utf-8']],
  ['/portrait-avatar.js', ['portrait-avatar.js', 'text/javascript; charset=utf-8']],
  ['/vendor/vrm-viewer.js', ['vendor/vrm-viewer.js', 'text/javascript; charset=utf-8']],
  ['/vendor/vrm-viewer.css', ['vendor/vrm-viewer.css', 'text/css; charset=utf-8']],
  ['/vendor/model-viewer.js', ['vendor/model-viewer.js', 'text/javascript; charset=utf-8']],
  ['/vendor/draco/draco_decoder.js', ['vendor/draco/draco_decoder.js', 'text/javascript; charset=utf-8']],
  ['/vendor/draco/draco_wasm_wrapper.js', ['vendor/draco/draco_wasm_wrapper.js', 'text/javascript; charset=utf-8']],
  ['/vendor/draco/draco_decoder.wasm', ['vendor/draco/draco_decoder.wasm', 'application/wasm']],
  ['/vendor/basis/basis_transcoder.js', ['vendor/basis/basis_transcoder.js', 'text/javascript; charset=utf-8']],
  ['/vendor/basis/basis_transcoder.wasm', ['vendor/basis/basis_transcoder.wasm', 'application/wasm']],
  ['/vendor/basis/worker.js', ['vendor/basis/worker.js', 'text/javascript; charset=utf-8', {
    // Fixed vendor embind code only. This policy does not apply to the owner UI.
    'content-security-policy': "default-src 'none'; script-src 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  }]],
  ['/google-backup.js', ['google-backup.js', 'text/javascript; charset=utf-8']],
  ['/boot-loader.js', ['boot-loader.js', 'text/javascript; charset=utf-8']],
  ['/boot-geometry.js', ['boot-geometry.js', 'text/javascript; charset=utf-8']],
  ['/boot-particles.js', ['boot-particles.js', 'text/javascript; charset=utf-8']],
  ['/boot-veil.js', ['boot-veil.js', 'text/javascript; charset=utf-8']],
  ['/boot-environment.js', ['boot-environment.js', 'text/javascript; charset=utf-8']],
  ['/interactions.js', ['interactions.js', 'text/javascript; charset=utf-8']],
  ['/integrations.js', ['integrations.js', 'text/javascript; charset=utf-8']],
  ['/desktop-media.js', ['desktop-media.js', 'text/javascript; charset=utf-8']],
  ['/microphone-activity-worklet.js', ['microphone-activity-worklet.js', 'text/javascript; charset=utf-8']],
  ['/wake-word.js', ['wake-word.js', 'text/javascript; charset=utf-8']],
  ['/wake-word-ui.js', ['wake-word-ui.js', 'text/javascript; charset=utf-8']],
  ['/desktop-screen-capture.js', ['desktop-screen-capture.js', 'text/javascript; charset=utf-8']],
  ['/on-device-inference.js', ['on-device-inference.js', 'text/javascript; charset=utf-8']],
  ['/on-device-chat.js', ['on-device-chat.js', 'text/javascript; charset=utf-8']],
  ['/on-device-worker.js', ['on-device-worker.js', 'text/javascript; charset=utf-8']],
  ['/vendor/web-llm.js', ['vendor/web-llm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/firebase-google.js', ['vendor/firebase-google.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/boot-loader.css', ['boot-loader.css', 'text/css; charset=utf-8']],
  ['/pairing.css', ['pairing.css', 'text/css; charset=utf-8']],
  ['/status.css', ['status.css', 'text/css; charset=utf-8']],
  ['/identity.css', ['identity.css', 'text/css; charset=utf-8']],
  ['/brand-motion.css', ['brand-motion.css', 'text/css; charset=utf-8']],
  ['/browser-crypto.js', ['browser-crypto.js', 'text/javascript; charset=utf-8']],
  ['/browser-vault.js', ['browser-vault.js', 'text/javascript; charset=utf-8']],
  ['/browser-providers.js', ['browser-providers.js', 'text/javascript; charset=utf-8']],
  ['/standalone-runtime.js', ['standalone-runtime.js', 'text/javascript; charset=utf-8']],
  ['/interactions.css', ['interactions.css', 'text/css; charset=utf-8']],
  ['/live-communication.css', ['live-communication.css', 'text/css; charset=utf-8']],
  ['/hexispace-embed.css', ['hexispace-embed.css', 'text/css; charset=utf-8']],
  ['/boot-layer.css', ['boot-layer.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache' }]],
  ['/pwa-policy.js', ['pwa-policy.js', 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache' }]],
  ['/pwa-connection.js', ['pwa-connection.js', 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache' }]],
  ['/icon.svg', ['icon.svg', 'image/svg+xml; charset=utf-8']],
  ['/brand-icosahedron.svg', ['brand-icosahedron.svg', 'image/svg+xml; charset=utf-8']]
]);

const PNG_ASSET = /^\/(?:icon-(?:192|512)|icon-maskable-(?:192|512)|apple-touch-icon-180|splash-(?:1170x2532|2048x2732))\.png$/;

async function sendFile({ res, publicDir, filename, contentType, headers, securityHeaders }) {
  const body = await fs.readFile(path.join(publicDir, filename));
  res.writeHead(200, { ...securityHeaders(contentType), ...headers });
  res.end(body);
}

export async function serveStaticAsset({ method, pathname, res, publicDir, securityHeaders, serveHtml }) {
  if (method !== 'GET') return false;
  if (pathname === '/') {
    serveHtml(res, 'index.html');
    return true;
  }
  if (pathname === '/offline-help.html') {
    serveHtml(res, 'offline-help.html');
    return true;
  }
  if (pathname === '/agent' || pathname === '/agent/' || pathname === '/agent-interface.html') {
    serveHtml(res, 'agent-interface.html');
    return true;
  }
  if (pathname === '/agent-link/connect') {
    serveHtml(res, 'agent-link-connect.html');
    return true;
  }

  const asset = STATIC_ASSETS.get(pathname);
  if (asset) {
    const [filename, contentType, headers = {}] = asset;
    await sendFile({ res, publicDir, filename, contentType, headers, securityHeaders });
    return true;
  }

  if (PNG_ASSET.test(pathname)) {
    await sendFile({ res, publicDir, filename: pathname.slice(1), contentType: 'image/png', headers: {}, securityHeaders });
    return true;
  }

  return false;
}
