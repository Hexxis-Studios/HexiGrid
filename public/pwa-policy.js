(function installHexiGridPwaPolicy(scope) {
  const CACHE_NAME = 'hexigrid-shell-v221';
  const SHELL_ASSETS = Object.freeze([
    '/', '/agent-interface.html', '/offline-help.html', '/brand.js', '/styles.css', '/identity.css',
    '/brand-motion.css', '/interactions.css', '/boot-layer.css', '/boot-loader.css',
    '/boot-geometry.js', '/boot-particles.js', '/boot-veil.js', '/boot-environment.js', '/boot-loader.js',
    '/device-preferences.js', '/interactions.js', '/browser-crypto.js', '/browser-vault.js', '/browser-providers.js',
    '/standalone-runtime.js', '/provider-limits.mjs', '/agent-interface.css', '/agent-interface.js', '/desktop-media.js', '/microphone-activity-worklet.js', '/incoming-voice-call.js', '/incoming-voice-call.css',
    '/on-device-inference.js', '/on-device-chat.js', '/icons.js', '/setup-prompts.js',
    '/guide-content.js', '/agent-ui.js', '/chat-ui.js', '/communication-ui.js', '/codex-deliveries-ui.js',
    '/workspace-ui.js', '/guide-ui.js', '/brand-icosahedron.svg', '/view-renderers.js',
    '/app.js', '/providers.js', '/harnesses.js', '/control-shell.js', '/task-ui.js', '/harness-job-ui.js',
    '/plugin-ui.js', '/hexikeys-ui.js', '/backup-ui.js', '/local-release-ui.js', '/google-backup.js', '/integrations.js',
    '/setup-prompt-ui.js', '/auth-ui.js', '/live-voice.js', '/live-recording.js',
    '/live-call.js', '/agent-link.js', '/agent-link-browser-client.js',
    '/agent-link-relay-client.js', '/agent-link-connect.js', '/agent-link-connect.css',
    '/agent-link-media.css', '/live-communication.css', '/manifest.webmanifest', '/icon.svg',
    '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png',
    '/apple-touch-icon-180.png', '/splash-1170x2532.png', '/splash-2048x2732.png',
    '/live-generated-voice.js', '/live-realtime.js', '/agent-mail.js', '/avatar-viewer.js', '/avatar-stage.js', '/portrait-avatar.js',
    '/hexispace-embed-mode.js', '/hexispace-embed.js', '/hexispace-embed.css',
    '/desktop-screen-capture.js', '/wake-word.js', '/wake-word-ui.js', '/vendor/firebase-google.js', '/pwa-policy.js', '/pwa-connection.js'
  ]);
  const LAZY_STATIC_ASSETS = Object.freeze([
    '/help/navigation.webp', '/help/memory.webp', '/help/workspace.webp',
    '/help/agent-choices.webp',
    '/help/agent-invitation.webp',
    '/help/avatars.webp',
    '/help/backup-controls.webp',
    '/help/backup-passphrase.webp',
    '/help/backup-schedule.webp',
    '/help/codex-routing.webp',
    '/help/computer-access.webp',
    '/help/local-job.webp',
    '/help/mcp-server.webp',
    '/help/memory-fact.webp',
    '/help/memory-sharing.webp',
    '/help/provider-api.webp',
    '/help/provider-local.webp',
    '/help/skill-editor.webp',
    '/help/task-schedule.webp',
    '/help/vault-plugin.webp',
    '/help/agent-api.webp',
    '/on-device-worker.js', '/vendor/web-llm.js',
    '/vendor/model-viewer.js'
  ]);
  const safePaths = new Set([...SHELL_ASSETS, ...LAZY_STATIC_ASSETS]);
  const forbiddenFragments = Object.freeze([
    '/api/', '/agent-link/connect', '/relay/', '/media/', '/audio/', '/video/',
    '/logs/', '/memory/', '/continuity/', '/draft', '/token', '/credential', '/auth/'
  ]);

  function isSafeCacheRequest(request, origin) {
    if (!request || request.method !== 'GET') return false;
    let url;
    try { url = new URL(request.url, origin); } catch { return false; }
    if (url.origin !== origin || url.search || url.hash) return false;
    const lowerPath = url.pathname.toLowerCase();
    if (forbiddenFragments.some((fragment) => lowerPath.includes(fragment))) return false;
    return safePaths.has(url.pathname);
  }

  scope.HexiGridPwaPolicy = Object.freeze({
    CACHE_NAME,
    SHELL_ASSETS,
    LAZY_STATIC_ASSETS,
    FORBIDDEN_FRAGMENTS: forbiddenFragments,
    isSafeCacheRequest
  });
})(globalThis);
