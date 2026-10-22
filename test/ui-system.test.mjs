import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('theme picker has four plain names with no marketing subtitles', async () => {
  const html = await read('public/index.html');
  const cards = [...html.matchAll(/<button\s+class="theme-card"[\s\S]*?<strong>([^<]+)<\/strong>([\s\S]*?)<\/button\s*>/g)];
  assert.deepEqual(cards.map((match) => match[1]), ['Dark', 'Light', 'Prism', 'Parchment']);
  assert.ok(cards.every((match) => !/<small\b/.test(match[2])));
});

test('button interaction module is optional-audio safe and cached with the app shell', async () => {
  const [html, source, cachePolicy, staticAssets, styles] = await Promise.all([
    read('public/index.html'), read('public/interactions.js'), read('public/pwa-policy.js'), read('lib/static-assets.mjs'), read('public/interactions.css')
  ]);
  assert.match(html, /src="\/interactions\.js"/);
  assert.match(html, /id="buttonSoundsEnabled"[^>]*checked/);
  assert.match(source, /HexiGridPreferences\.getItem\(STORAGE_KEY\) !== 'off'/);
  assert.match(source, /window\.AudioContext \|\| window\.webkitAudioContext/);
  assert.match(source, /audioContext\.resume\(\)\.then/);
  assert.match(source, /catch \{[\s\S]*never interrupt the button action/);
  assert.match(source, /pointerdown/);
  assert.match(styles, /hexButtonRelease/);
  assert.match(styles, /@media\(hover:hover\) and \(pointer:fine\)/);
  assert.match(cachePolicy, /'\/interactions\.js'/);
  assert.match(staticAssets, /'\/interactions\.js'/);
});

test('boot layer, modular features, and guide links are wired together', async () => {
  const [html, bootLayer, brandMotion, guides, guideUi] = await Promise.all([
    read('public/index.html'), read('public/boot-layer.css'), read('public/brand-motion.css'), read('public/guide-content.js'), read('public/guide-ui.js')
  ]);
  for (const module of ['agent-ui', 'chat-ui', 'on-device-chat', 'communication-ui', 'workspace-ui', 'guide-ui', 'providers', 'harnesses', 'control-shell', 'task-ui', 'plugin-ui', 'backup-ui', 'auth-ui', 'google-backup', 'integrations', 'interactions', 'setup-prompts', 'setup-prompt-ui', 'view-renderers']) {
    assert.match(html, new RegExp(`src="/${module}\\.js"`));
  }
  assert.match(bootLayer, /body\.booting>\.app-shell/);
  assert.match(bootLayer, /body\.booting>\.auth-gate/);
  assert.match(brandMotion, /brandSweep/);
  assert.match(brandMotion, /mask:url\("\/brand-icosahedron\.svg"\)/);
  for (const key of [...html.matchAll(/data-guide="([^"]+)"/g)].map((match) => match[1])) {
    assert.match(guides, new RegExp(`\\b${key}: topic\\(`), `missing guide topic: ${key}`);
  }
  for (const topic of ['openai', 'anthropic', 'gemini', 'huggingface', 'ollama', 'lmstudio', 'cli', 'ilands', 'tools', 'backup']) {
    assert.match(guides, new RegExp(`${topic}: topic\\([\\s\\S]*?officialLinks:`), `missing official links for ${topic}`);
  }
  assert.match(guideUi, /Official source/);
});

test('family brand mark uses the shared icosahedron and HexiSpace wordmark motion', async () => {
  const [html, brandMotion, pwaPolicy, staticAssets, mark] = await Promise.all([
    read('public/index.html'), read('public/brand-motion.css'), read('public/pwa-policy.js'), read('lib/static-assets.mjs'), read('public/brand-icosahedron.svg')
  ]);
  assert.match(html, /src="\/brand-icosahedron\.svg"/);
  assert.match(brandMotion, /brand-spectrum 9s ease-in-out infinite alternate/);
  assert.match(brandMotion, /animation-duration:4s/);
  assert.match(brandMotion, /mask:url\("\/brand-icosahedron\.svg"\)/);
  assert.match(brandMotion, /prefers-reduced-motion:reduce[^}]*\.brand-mark\{animation:none!important/);
  assert.match(pwaPolicy, /'\/brand-icosahedron\.svg'/);
  assert.match(staticAssets, /'\/brand-icosahedron\.svg'/);
  assert.match(mark, /wireframe icosahedron/);
});

test('development browser reset is server-controlled and limited to HexiGrid preferences', async () => {
  const source = await read('public/app.js');
  assert.match(source, /identity\.developmentFreshStart/);
  assert.match(source, /key\.startsWith\('hexigrid-'\) \|\| key\.startsWith\('aveniq-'\)/);
  assert.doesNotMatch(source, /localStorage\.clear\(\)|sessionStorage\.clear\(\)/);
});

test('model catalog refresh fails with a friendly message if startup data is not ready', async () => {
  const source = await read('public/app.js');
  assert.match(source, /async function refreshModels\(\) \{\s*if \(!state\.data\) \{\s*notify\("HexiGrid is still loading\. Try again when the workspace opens\."/);
  assert.match(source, /const data = state\.data;\s*if \(!data\) \{\s*notify\("HexiGrid is still loading\. Try again when the workspace opens\."/);
  assert.match(source, /if \(data\.bridge\) data\.bridge\.modelCatalogError = response\.error \|\| ''/);
});

test('a truly empty first launch has a usable chat-room empty state', async () => {
  const source = await read('public/chat-ui.js');
  assert.match(source, /No chat room yet/);
  assert.match(source, /Create a room first/);
  assert.match(source, /input\.disabled = true/);
  assert.match(source, /input\.disabled = replyingHere/);
});

test('passcode setup hides onboarding until local authentication is complete', async () => {
  const [auth, app] = await Promise.all([read('public/auth-ui.js'), read('public/app.js')]);
  assert.match(auth, /querySelector\('#onboarding'\)\?\.classList\.add\('hidden'\)/);
  assert.match(app, /\$\("#authGate"\)\.classList\.contains\("hidden"\)/);
  assert.match(auth, /api\('\/api\/auth\/status'\)[\s\S]*await window\.hexigridGoogleReady/);
  assert.match(app, /window\.hexigridAuthInitialized/);
});

test('owner memory review keeps provenance visible and confirmation separate from proposal approval', async () => {
  const integrations = await read('public/integrations.js');
  assert.match(integrations, /Owner-confirmed.*Unverified.*source:/);
  assert.match(integrations, /data-memory-confirm=/);
  const noteReview = integrations.slice(integrations.indexOf("const confirmMemoryButton ="), integrations.indexOf("const editMemoryButton ="));
  assert.match(noteReview, /label: 'Exact note'.*readonly: true/);
  assert.match(noteReview, /label: 'Source'.*readonly: true/);
  assert.match(noteReview, /label: 'Validity condition'.*readonly: true/);
  assert.match(noteReview, /label: 'Why is this source confirmed\?', required: true/);
  assert.match(noteReview, /\/api\/memories\/\$\{encodeURIComponent\(memory\.id\)\}\/confirm/);
  assert.match(noteReview, /expectedRevision: memory\.revisions\?\.length \|\| 0, why: values\.at\(-1\), approved: true/);
  assert.match(integrations, /Approval writes an exact dated fact or correction for this agent as unverified/);
  assert.match(integrations, /The dated memory is stored as unverified/);
  assert.match(integrations, /operation: 'confirm', id: result\.memoryId, expectedRevision: result\.revision, why: confirmation\[5\], approved: true/);
});

test('duplicate agent names are distinguishable and roster search follows its label', async () => {
  const [app, roster, chat, live, tasks, avatarStage, renderers] = await Promise.all([read('public/app.js'), read('public/agent-ui.js'), read('public/chat-ui.js'), read('public/live-call.js'), read('public/task-ui.js'), read('public/avatar-stage.js'), read('public/view-renderers.js')]);
  assert.match(app, /function agentListLabel\(item\)/);
  assert.match(app, /duplicates\.length > 1/);
  assert.match(roster, /agentListLabel\(item\)/);
  assert.match(roster, /agentRosterAccountLabel\(item\)/);
  assert.match(roster, /agentRosterLink\(item\)\?\.id/);
  assert.doesNotMatch(roster, /item\.transport\} \$\{item\.model\}/);
  assert.match(chat, /agentListLabel\(item\)/);
  assert.match(live, /agentListLabel\(item\)/);
  assert.match(tasks, /agentListLabel\(agent\)/);
  assert.match(avatarStage, /agentListLabel\(item\)/);
  assert.match(renderers, /agentListLabel\(item\)/);
});

test('interactive regressions keep previews, activity, and bridge liveness honest', async () => {
  const [communication, app, renderers, integrations, agentInterface, styles, backup] = await Promise.all([
    read('public/communication-ui.js'),
    read('public/app.js'),
    read('public/view-renderers.js'),
    read('public/integrations.js'),
    read('public/agent-interface.js'),
    read('public/styles.css'),
    read('public/google-backup.js')
  ]);
  assert.match(communication, /#communicationExamples \.example-card\[data-example-index\]/);
  assert.match(styles, /\.live-media-empty\[hidden\][^{]*\{[^}]*display: none !important/);
  assert.match(app, /activityVisibleCount: 100/);
  assert.match(renderers, /events\.slice\(0, visibleCount\)/);
  assert.match(renderers, /data-action="show-more-activity"/);
  assert.match(styles, /\.timeline-event \{ display: grid/);
  assert.match(renderers, /aria-labelledby="confirmModalTitle"/);
  assert.doesNotMatch(integrations, /aria-labelledby="confirmModalTitle"/);
  assert.doesNotMatch(renderers, /aria-labelledby="modalTitle"/);
  assert.match(renderers, /runnerProfiles[\s\S]*runtime\?\.running === true/);
  assert.match(integrations, /const bridgeLive = activeSessionSelected && selectedOnline/);
  assert.match(integrations, /desktopBridgeDraftLinkId !== select\.value/);
  assert.match(integrations, /const liveCameraSession = bridge\.enabled && bridge\.linkId === selectedLinkId && selectedLink\?\.status === 'online' && window\.HexiGridDesktopMedia\?\.sessionReady\?\.\(\)/);
  assert.match(integrations, /selected Hexonaut is offline/);
  assert.match(agentInterface, /HexiGridViewRenderers\.linkPresence\(link\)\.label/);
  assert.match(agentInterface, /owner connection is offline/);
  assert.match(backup, /Loading backup history/);
});

test('Google setup is one click and never asks an end user for developer credentials', async () => {
  const [html, google, firebaseClient, server] = await Promise.all([read('public/index.html'), read('public/google-backup.js'), read('client/firebase-google.js'), read('server.mjs')]);
  assert.match(html, /Continue with Google/);
  assert.match(html, /src="\/vendor\/firebase-google\.js"/);
  assert.match(google, /HexiGridGoogle\.connect/);
  assert.match(google, /\/api\/auth\/google\/firebase/);
  assert.doesNotMatch(html, /data-action="onboarding-google"/);
  assert.match(html, /id="googleSummaryBadge"/);
  assert.match(google, /function setGoogleAccount/);
  assert.match(firebaseClient, /auth\.currentUser && !force/);
  assert.match(firebaseClient, /const driveProvider = new GoogleAuthProvider\(\)/);
  assert.match(firebaseClient, /signInWithPopup\(auth, provider\)/);
  assert.doesNotMatch(firebaseClient, /signInWithRedirect|redirectSignIn|shouldUseRedirect/);
  assert.doesNotMatch(firebaseClient.slice(0, firebaseClient.indexOf('const driveProvider')), /drive\.appdata/);
  assert.match(firebaseClient, /await auth\.authStateReady\(\)/);
  assert.match(firebaseClient, /idToken\(\)/);
  assert.doesNotMatch(`${html}\n${google}\n${server}`, /googleClientId|Desktop OAuth client|api\/sync\/google/);
});

test('agent-record import is provider-neutral and keeps the optional iLands connector separate', async () => {
  const [integrations, linkUi, identityStyles, server] = await Promise.all([read('public/integrations.js'), read('public/agent-link.js'), read('public/identity.css'), read('server.mjs')]);
  assert.match(integrations, /Import an existing agent/);
  assert.match(integrations, /AGENT RECORD/);
  assert.match(integrations, /any agent that can create a Markdown record/);
  assert.match(integrations, /does not connect to or change the agent in its current app/);
  assert.doesNotMatch(integrations, /EXISTING ILANDS AGENT/);
  assert.match(integrations, /Connect an iLands account/);
  assert.match(integrations, /OPTIONAL CONNECTOR · ILANDS/);
  assert.match(integrations, /Existing iLands agents cannot connect directly yet/);
  assert.doesNotMatch(integrations, /Direct connection · Coming soon/);
  assert.doesNotMatch(integrations, /BYOA/);
  assert.match(integrations, /id="continuityPromptCopy"/);
  assert.match(integrations, /id="continuityMarkdownFiles"[^>]*multiple/);
  assert.doesNotMatch(integrations, /id="agentLinkCreate"/);
  assert.match(integrations, /data-guide="agentRecord"/);
  assert.match(linkUi, /\/api\/continuity\/markdown-prompt/);
  assert.match(linkUi, /\/api\/continuity\/import-markdown/);
  assert.match(linkUi, /Name this profile/);
  assert.doesNotMatch(linkUi, /iLands agent|iLander|officialByoaStartPrompt/);
  assert.match(linkUi, /connect it through HexiGrid Link/);
  assert.match(integrations, /id="continuityPackageImport"/);
  assert.match(linkUi, /\/api\/continuity\/import/);
  assert.match(linkUi, /continuity-package/);
  assert.match(linkUi, /Move activity/);
  assert.doesNotMatch(linkUi, /BYOA/);
  const [index, prompts, promptUi, guides] = await Promise.all([read('public/index.html'), read('public/setup-prompts.js'), read('public/setup-prompt-ui.js'), read('public/guide-content.js')]);
  assert.doesNotMatch(index, /Paste after BYOA verification/);
  assert.match(prompts, /label: 'iLands connection'/);
  assert.match(promptUi, /<option value="ilands">iLands connection<\/option>/);
  assert.match(promptUi, /<option value="" disabled selected>Choose a framework<\/option><option value="compatible">Another framework/);
  assert.match(promptUi, /if \(!choice\) return notify\('Choose a destination first\.'/);
  assert.doesNotMatch(promptUi, /<option value="ilands" selected/);
  assert.doesNotMatch(promptUi, /iLands BYOA/);
  assert.doesNotMatch(guides, /iLands BYOA|BYOA-ready|BYOA iLander/);
  assert.match(linkUi, /if \(!state\.data\) return result\.connections \|\| \[\]/);
  assert.match(linkUi, /renderDesktopBridge\(\)/);
  assert.match(linkUi, /if \(state\.data\) appRendered\(\)/);
  assert.match(integrations, /const pendingLinkId = select\.value/);
  assert.match(integrations, /desktopBridgeSelectionTouched/);
  assert.match(integrations, /bridge\.linkId \|\| desktopBridgeSelection \|\| pendingLinkId/);
  assert.match(integrations, /desktopBridgeDraft/);
  assert.match(integrations, /id="desktopBridgeRemoveLink"/);
  assert.match(integrations, /body: JSON\.stringify\(\{ purge: true, approved: true \}\)/);
  assert.match(integrations, /const controlGranted = document\.querySelector\('#desktopBridgeControl'\)\.checked/);
  assert.match(identityStyles, /\.bridge-form\{/);
  assert.match(identityStyles, /\.bridge-permission-grid\{/);
  assert.match(server, /if \(purge\) state\.agentLinks = state\.agentLinks\.filter/);
  assert.match(integrations, /data-runner-action="remove"/);
  assert.match(linkUi, /data-link-disconnect/);
  assert.match(linkUi, /\{ purge: true, approved: true \}/);
  assert.match(linkUi, /Connected \$\{escapeHtml\(when\)\} · link/);
  const agents = await read('public/agent-ui.js');
  assert.match(agents, /data-action="remove-agent"/);
  assert.match(agents, /async function removeAgentById/);
});

test('onboarding exposes the same three-prompt setup center used by Connections and tools', async () => {
  const [html, promptUi, promptSource, styles] = await Promise.all([read('public/index.html'), read('public/setup-prompt-ui.js'), read('public/setup-prompts.js'), read('public/styles.css')]);
  assert.match(html, /data-setup-prompt="hexigrid"/);
  assert.match(html, /data-action="open-prompt-center"/);
  assert.match(promptUi, /THREE GUIDED PROMPTS/);
  assert.match(promptUi, /data-setup-prompt="record"/);
  assert.match(promptSource, /HEXIGRID-AGENT-RECORD\.md/);
  assert.match(styles, /\.setup-prompt-flow\{[^}]*grid-template-columns:repeat\(3/);
});

test('boot artwork uses modular particles, a healing veil, and a compositor-safe unlock', async () => {
  const [html, styles, environment, geometry, particles, veil, loader, interactions, cachePolicy, staticAssets] = await Promise.all([
    read('public/index.html'),
    read('public/boot-loader.css'),
    read('public/boot-environment.js'),
    read('public/boot-geometry.js'),
    read('public/boot-particles.js'),
    read('public/boot-veil.js'),
    read('public/boot-loader.js'),
    read('public/interactions.js'),
    read('public/pwa-policy.js'),
    read('lib/static-assets.mjs')
  ]);
  assert.match(html, /id="bootEnvironment"/);
  assert.doesNotMatch(html, /id="bootVeil"/);
  assert.match(html, /boot-geometry\.js[\s\S]*boot-particles\.js[\s\S]*boot-veil\.js[\s\S]*boot-environment\.js/);
  assert.match(styles, /\.boot-environment\{[^}]*inset:0[^}]*width:100%[^}]*height:100%/);
  assert.match(styles, /\.boot-environment\{[^}]*opacity:\.82/);
  assert.match(styles, /\.boot-hologram\{[^}]*width:min\(76vmin,720px\)/);
  assert.match(styles, /\.boot-loader\.opening \.boot-hologram\{[^}]*opacity:1[^}]*scale\(1\.04\)/);
  assert.match(styles, /\.boot-loader\.departing \.boot-hologram\{[^}]*scale\(4\.8\)/);
  assert.match(styles, /\.boot-loader\.departing \.boot-environment\{opacity:0\}/);
  assert.match(environment, /HexiGridParticleField/);
  assert.match(environment, /HexiGridRevealVeil/);
  assert.match(environment, /const maxLength = coarsePointer \? 110 : 150/);
  assert.match(environment, /tailBias/);
  assert.match(environment, /healingRate/);
  assert.match(environment, /function move\(event\) \{\s+if \(reduced\) return;/);
  assert.match(environment, /now - motionAt < 110/);
  assert.match(environment, /const healingRate = \(moving \? \.55 : \.8\) \+ tailBias \* 1\.25/);
  assert.match(environment, /frameInterval/);
  assert.match(environment, /addEventListener\('pointermove'/);
  assert.match(environment, /addEventListener\('pointerdown'/);
  assert.match(particles, /HexiGridParticleField/);
  assert.match(particles, /document\.createElement\('canvas'\)/);
  assert.match(particles, /HexiGridBootGeometry/);
  assert.match(loader, /HexiGridBootGeometry/);
  assert.match(geometry, /const rawVertices/);
  assert.match(geometry, /const rawFaces/);
  assert.match(particles, /Math\.pow\(1 - distance \/ influence, 2\)/);
  assert.match(particles, /particle\.bloom/);
  assert.match(particles, /1152 \/ width/);
  assert.doesNotMatch(particles, /drawHexagon|drawDoubleHexagon/);
  assert.match(veil, /HexiGridRevealVeil/);
  assert.match(veil, /destination-out/);
  assert.match(veil, /destination-over/);
  assert.match(veil, /drawImage\(source, x, y, regionWidth, regionHeight/);
  assert.match(veil, /lineCap = 'round'/);
  assert.match(veil, /paint\(union\(previousBounds, currentBounds\)\)/);
  assert.match(veil, /Math\.pow\(\(from\.life \+ to\.life\) \/ 2, \.72\)/);
  assert.match(veil, /function segmentPath/);
  assert.match(veil, /const REVEAL_SCALE = 2\.5/);
  assert.match(veil, /paint\(\{ x: 0, y: 0, width, height \}\)/);
  assert.match(veil, /surface\.addColorStop\(0, '#41d3ec'\)/);
  assert.match(veil, /const baseCanvas = document\.createElement\('canvas'\)/);
  assert.match(veil, /clearRect\(x, y, regionWidth, regionHeight\)/);
  assert.match(veil, /globalCompositeOperation = 'source-over'/);
  assert.doesNotMatch(veil, /globalCompositeOperation = 'copy'/);
  assert.match(veil, /drawImage\(baseCanvas, x, y, regionWidth, regionHeight/);
  assert.match(loader, /strokeText\('CLICK TO ENTER'/);
  assert.match(loader, /devicePixelRatio \|\| 1, 1\.1/);
  assert.match(loader, /frameInterval/);
  assert.match(loader, /loader\.classList\.add\('opening'\)/);
  assert.match(loader, /const FACET_STEP_MS = 102/);
  assert.match(loader, /const FACET_MOVE_MS = 310/);
  assert.match(loader, /const OUTER_UNLOCK_MS = FACET_STEP_MS \* \(faces\.length - 1\) \+ FACET_MOVE_MS/);
  assert.match(loader, /outerUnlockRank\[item\.faceIndex\] \* FACET_STEP_MS/);
  assert.match(loader, /smoothstep\(unlockElapsed \/ OUTER_UNLOCK_MS\)/);
  assert.match(loader, /smoothstep\(\(unlockElapsed - OUTER_UNLOCK_MS\) \/ CORE_RADIANCE_MS\)/);
  assert.match(loader, /const reactorHeat = reduced \? unlock : smoothstep\(unlockElapsed \/ OUTER_UNLOCK_MS\)/);
  assert.match(loader, /playFacetSequence\?\.\(\{ count: faces\.length, stepMs: FACET_STEP_MS \}\)/);
  assert.match(interactions, /function playFacetSequence/);
  assert.match(interactions, /firstTick \+ index \* stepMs \/ 1000/);
  assert.match(interactions, /if \(!soundsEnabled\(\)\) return/);
  assert.match(loader, /function drawInnerRadiance/);
  assert.match(loader, /drawMesh\(size, \.39,[^\n]+, 0, elapsed, true, instability\)/);
  assert.match(loader, /setTimeout\(\(\) => loader\.classList\.add\('departing'\), OUTER_UNLOCK_MS \+ CORE_RADIANCE_MS \* \.76\)/);
  assert.match(styles, /24%\{opacity:\.5\}/);
  assert.match(loader, /document\.hidden/);
  assert.match(loader, /Math\.min\(width, height\)/);
  assert.match(loader, /render\(performance\.now\(\)\)/);
  assert.doesNotMatch(loader, /drawUnlockFlash/);
  for (const asset of ['/boot-geometry.js', '/boot-particles.js', '/boot-veil.js']) {
    assert.match(cachePolicy, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(staticAssets, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
