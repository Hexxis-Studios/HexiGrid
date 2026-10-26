import { captureDesktopFrame, desktopBridgeAuthorized, desktopBridgeSession, updateDesktopBridgeSession, dispatchDesktopInput, enforceDesktopRateLimit, publicDesktopBridge, resumeDesktopControl, startDesktopBridge, stopDesktopBridge, takeDesktopControl, coordinateDesktopRequest } from './desktop-bridge.mjs';
import { clearDesktopMicrophone, clearDesktopSpeaker, nextDesktopMicrophoneSequence, pauseDesktopAudio, pauseDesktopMediaKind, publicDesktopMedia, publishCameraFrame, publishMicrophoneChunk, readDesktopSpeaker, setDesktopCameraEnabled, setDesktopMediaKind, startDesktopMedia, stopDesktopMedia, stopDesktopMediaKind } from './desktop-media.mjs';
import { publishBrowserDesktopFrame } from './desktop-screen.mjs';
import { queueAgentLinkEvent } from './agent-link.mjs';
import { answerVoiceCall, requireVoiceCall, endVoiceCall, interruptVoiceCall, muteVoiceCall, publicVoiceCall, setVoiceCallMicrophoneSequenceStart, startVoiceCall } from './voice-call.mjs';
import { isPresenceFarewell } from './on-request-presence.mjs';
import { callMediaBridge } from './call-media-authority.mjs';
import { selectVoiceCall } from './voice-call.mjs';

function publicFrame(frame) {
  return { mimeType: frame.mimeType, data: frame.data.toString('base64'), capturedAt: frame.capturedAt, source: frame.source || 'native' };
}

function hasCapability(connection, capability) {
  return Array.isArray(connection?.capabilities) && connection.capabilities.includes(capability);
}

function hasApprovedCapability(connection, capability) {
  return (connection?.ownerGrantedCapabilities || connection?.capabilities || []).includes(capability);
}

// Called only after the owner action passes policy and the call service validates it.
function resumeOwnerCallMedia(state, connection, video = false) {
  const scopes = ['microphone-listen', 'speaker-output', ...(video ? ['camera-view'] : [])];
  connection.capabilities = [...new Set([...connection.capabilities, ...scopes])];
  const session = desktopBridgeSession(state.settings.desktopBridge, connection.id);
  state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, {
    mediaGrants: { ...session.mediaGrants, microphone: true, speaker: true, ...(video ? { camera: true } : {}) },
    mediaPausedByOwner: { ...session.mediaPausedByOwner, microphone: false, speaker: false, ...(video ? { camera: false } : {}) }
  });
  startDesktopMedia({ linkId: connection.id, microphoneGranted: true, speakerGranted: true, cameraGranted: hasCapability(connection, 'camera-view'), preserveSequences: true });
}

/** Apply an owner response to an agent-originated call after validating the live grant. */
export async function applyOwnerIncomingVoiceCallAction({ state, callId, action, acceptedVia = 'browser', connectorPolicy, addReceipt, saveState, onVoiceCallStarted }) {
  if (!['accept', 'decline'].includes(action)) throw Object.assign(new Error('Choose Accept or Decline for this call.'), { status: 400 });
  const current = publicVoiceCall();
  const bridge = callMediaBridge(state, current.linkId);
  requireVoiceCall(bridge.linkId, ['ringing']);
  if (!callId || callId !== current.id || current.direction !== 'agent-to-owner') throw Object.assign(new Error('This incoming call invitation is stale.'), { status: 409 });
  const connection = state.agentLinks.find(item => item.id === bridge.linkId && item.status === 'connected');
  const accept = action === 'accept';
  let voiceCall;
  if (accept) {
    if (!hasCapability(connection, 'microphone-listen') || !hasCapability(connection, 'speaker-output')) throw Object.assign(new Error('Both audio permissions must still be granted.'), { status: 403 });
    const denied = connectorPolicy('conversation', 'high', true);
    if (denied) throw Object.assign(new Error(denied.error || 'Current policy blocks this call.'), { status: denied.denied ? 403 : 409, policyDecision: denied });
    setDesktopMediaKind(bridge.linkId, 'microphone', true);
    setDesktopMediaKind(bridge.linkId, 'speaker', true);
    state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, bridge.linkId, {
      mediaGrants: { ...bridge.mediaGrants, microphone: true, speaker: true },
      mediaPausedByOwner: { ...bridge.mediaPausedByOwner, microphone: false, speaker: false }
    });
    voiceCall = answerVoiceCall(bridge.linkId, { by: 'owner', callId, acceptedVia });
    onVoiceCallStarted?.(voiceCall);
  } else {
    voiceCall = endVoiceCall(bridge.linkId, 'owner-declined');
    pauseDesktopAudio(bridge.linkId, 'owner-declined');
  }
  if (connection) queueAgentLinkEvent(connection, { type: accept ? 'voice.call.accepted' : 'voice.call.ended', text: accept ? 'The owner accepted your call. Enter call-handling mode: receive speech.transcript.final events for this call, answer through voice-call-reply, and continue until the call ends. A sleeping provider needs its supported message adapter to wake for each turn; a queued Link event alone cannot wake it. See orientation.callHandling for the exact commands.' : 'The owner declined your call.', metadata: { callId: voiceCall.id, mediaEpoch: voiceCall.mediaEpoch, reason: voiceCall.stopReason } });
  const receipt = addReceipt({ agentId: connection?.agentId || null, action: accept ? 'voice-call:accept' : 'voice-call:decline', capability: 'conversation', risk: 'high', status: 'completed', detail: accept ? `The owner accepted the agent-initiated call from the ${acceptedVia === 'windows-toast' ? 'Windows notification' : 'browser call prompt'}.` : `The owner declined the agent-initiated call from the ${acceptedVia === 'windows-toast' ? 'Windows notification' : 'browser call prompt'}.`, source: 'voice-call' });
  await saveState();
  return { voiceCall, media: publicDesktopMedia(), receipt };
}

/** Owner-authenticated controls for the native HexiGrid desktop bridge. */
export async function handleDesktopBridgeRequest(req, res, ctx) {
  const { state, pathname, method, readBody, json, connectorPolicy, addReceipt, addActivity, saveState, findAgent, now, localTranscriber, avatarPresence, onRequestPresence, getVoiceCallTranscripts, onVoiceTranscript, onVoiceCallStarted } = ctx;
  if (!pathname.startsWith('/api/desktop-bridge')) return false;
  if (method === 'GET' && pathname === '/api/desktop-bridge') {
    const bridge = publicDesktopBridge(state.settings.desktopBridge);
    const voiceCall = publicVoiceCall();
    const audioLinkId = voiceCall.status === 'active' ? voiceCall.linkId : bridge.linkId;
    const connection = state.agentLinks.find(item => item.id === audioLinkId && item.status === 'connected');
    const callCanTranscribe = voiceCall.status === 'active' && voiceCall.linkId === audioLinkId && !voiceCall.ownerMuted && hasCapability(connection, 'microphone-listen') && connection?.transcription?.memoryOnly !== true;
    let callBridge = bridge, callAuthorized = false;
    if (['offered', 'ringing', 'active'].includes(voiceCall.status)) {
      try { callBridge = callMediaBridge(state); callAuthorized = true; } catch { /* Revoked or replaced sessions expose no call media. */ }
    }
    const transcripts = bridge.enabled && callAuthorized && voiceCall.linkId === audioLinkId && callCanTranscribe
      ? getVoiceCallTranscripts?.({ linkId: audioLinkId, call: voiceCall, enabled: true }) || []
      : [];
    json(res, 200, { bridge, callBridge, media: callAuthorized || !['offered', 'ringing', 'active'].includes(voiceCall.status) ? publicDesktopMedia(audioLinkId) : { cameraGranted: false, microphoneGranted: false, speakerGranted: false }, voiceCall, presence: onRequestPresence?.status() || null, transcripts }); return true;
  }
  if (method === 'GET' && pathname === '/api/desktop-bridge/frame') {
    try {
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'desktop-view', action: 'view' });
      enforceDesktopRateLimit(bridge.linkId, 'frame');
      const frame = await coordinateDesktopRequest({ linkId: `owner:${bridge.linkId}`, observe: true,
        authorize: () => desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: bridge.linkId, capability: 'desktop-view', action: 'view' }) }, () => captureDesktopFrame());
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, bridge.linkId, { lastFrameAt: frame.capturedAt });
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), frame: publicFrame(frame) }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, bridge: publicDesktopBridge(state.settings.desktopBridge) }); return true; }
  }
  if (method !== 'POST') { json(res, 405, { error: 'Use GET or POST for the desktop bridge.' }); return true; }
  const mediaUpload = pathname === '/api/desktop-bridge/media/camera' || pathname === '/api/desktop-bridge/media/microphone';
  const browserFrameUpload = pathname === '/api/desktop-bridge/browser-frame';
  const body = await readBody(req, mediaUpload || browserFrameUpload ? 1900 * 1024 : 64 * 1024);
  if (pathname === '/api/desktop-bridge/start') {
    const connection = state.agentLinks.find((item) => item.id === String(body.linkId || '') && item.status === 'connected');
    if (!connection) { json(res, 404, { error: 'Choose a connected Hexonaut link first.' }); return true; }
    const viewGranted = body.viewGranted !== false;
    const controlGranted = body.controlGranted === true;
    const textGranted = body.textGranted === true;
    const cameraGranted = body.cameraGranted === true;
    const microphoneGranted = body.microphoneGranted === true;
    const speakerGranted = body.speakerGranted === true;
    if ((viewGranted && !hasCapability(connection, 'desktop-view')) || (controlGranted && !hasCapability(connection, 'desktop-control')) || (textGranted && (!controlGranted || !hasCapability(connection, 'desktop-type'))) || (cameraGranted && !hasCapability(connection, 'camera-view')) || (microphoneGranted && !hasCapability(connection, 'microphone-listen')) || (speakerGranted && !hasCapability(connection, 'speaker-output'))) { json(res, 403, { error: 'This Hexonaut link was not granted the requested computer or media permission.' }); return true; }
    const denied = connectorPolicy('run_tools', 'critical', body.approved === true);
    if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
    try {
      endVoiceCall(connection.id, 'bridge-restarted');
      state.settings.desktopBridge = startDesktopBridge(state.settings.desktopBridge, { linkId: connection.id, viewGranted, controlGranted, textGranted, cameraGranted, microphoneGranted, speakerGranted });
      const media = startDesktopMedia({ linkId: connection.id, cameraGranted, microphoneGranted, speakerGranted });
      const mediaNames = [cameraGranted && 'camera', microphoneGranted && 'microphone', speakerGranted && 'agent speaker output'].filter(Boolean);
      const permissions = [viewGranted && 'screen view', controlGranted && 'computer control', textGranted && 'text input', ...mediaNames].filter(Boolean);
      const detail = `${connection.identity.name} received ${permissions.join(', ')} through the native HexiGrid bridge. The owner can stop access at any time.`;
      const receipt = addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:start', capability: 'run_tools', risk: 'critical', status: 'completed', detail, source: 'desktop-bridge' });
      queueAgentLinkEvent(connection, { type: 'desktop.session.started', text: detail, metadata: { controlGranted, cameraGranted, microphoneGranted, speakerGranted } });
      addActivity('security', `${connection.identity.name} computer access started.`);
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), media, receipt }); return true;
    } catch (error) { json(res, error.status || 400, { error: error.message }); return true; }
  }
  if (browserFrameUpload) {
    try {
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'desktop-view', action: 'owner-screen' });
      const connection = state.agentLinks.find((item) => item.id === bridge.linkId && item.status === 'connected');
      if (!hasCapability(connection, 'desktop-view')) { json(res, 403, { error: 'Screen view is no longer granted to this Link.' }); return true; }
      enforceDesktopRateLimit(bridge.linkId, 'owner-frame');
      const result = publishBrowserDesktopFrame(body);
      json(res, 202, { ok: true, ...result }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message }); return true; }
  }
  if (pathname === '/api/desktop-bridge/stop') {
    const connection = state.agentLinks.find((item) => item.id === (body.linkId || state.settings.desktopBridge?.linkId) && item.status === 'connected');
    if (connection) queueAgentLinkEvent(connection, { type: 'desktop.session.stopped', text: 'The owner stopped computer and media access.', metadata: { reason: 'owner-stop' } });
    endVoiceCall(typeof body.linkId === 'string' ? body.linkId : '', 'owner-stop');
    const stoppedLinkId = typeof body.linkId === 'string' ? body.linkId : '';
    state.settings.desktopBridge = stopDesktopBridge(state.settings.desktopBridge, 'owner-stop', stoppedLinkId);
    stopDesktopMedia('owner-stop', stoppedLinkId);
    avatarPresence?.hide('bridge-stop');
    onRequestPresence?.deactivate('bridge-stop');
    const receipt = addReceipt({ action: 'desktop-bridge:stop', capability: 'emergency_stop', risk: 'critical', status: 'completed', detail: 'The owner stopped all native HexiGrid computer access immediately.', source: 'desktop-bridge' });
    addActivity('security', 'The owner stopped the native HexiGrid computer bridge.');
    await saveState();
    json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), receipt }); return true;
  }
  if (pathname === '/api/desktop-bridge/takeover') {
    try {
      endVoiceCall('', 'owner-takeover');
      state.settings.desktopBridge = takeDesktopControl(state.settings.desktopBridge);
      stopDesktopMedia('owner-takeover');
      avatarPresence?.hide('owner-takeover');
      onRequestPresence?.deactivate('owner-takeover');
      const connection = state.agentLinks.find((item) => item.id === state.settings.desktopBridge.linkId && item.status === 'connected');
      if (connection) queueAgentLinkEvent(connection, { type: 'desktop.control.paused', text: 'The owner took control. Agent input is paused.', metadata: { reason: 'owner-takeover' } });
      const receipt = addReceipt({ agentId: state.agentLinks.find((item) => item.id === state.settings.desktopBridge.linkId)?.agentId || null, action: 'desktop-bridge:takeover', capability: 'emergency_stop', risk: 'critical', status: 'completed', detail: 'The owner took control of the computer. Agent input is paused while screen view remains available.', source: 'desktop-bridge' });
      addActivity('security', 'The owner took control of the computer from the connected Hexonaut.');
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message }); return true; }
  }
  if (pathname === '/api/desktop-bridge/resume') {
    const denied = connectorPolicy('run_tools', 'high', body.approved === true);
    if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
    try {
      const linkId = String(body.linkId || state.settings.desktopBridge.linkId);
      const connection = state.agentLinks.find(item => item.id === linkId && item.status === 'connected');
      if (!hasCapability(connection, 'desktop-control')) throw Object.assign(new Error('This agent does not have mouse and keyboard permission.'), {status: 403});
      resumeDesktopControl(desktopBridgeSession(state.settings.desktopBridge, linkId));
      state.settings.desktopBridge = resumeDesktopControl(state.settings.desktopBridge);
      if (connection) queueAgentLinkEvent(connection, { type: 'desktop.control.resumed', text: 'The owner restored the current computer-control grant.', metadata: {} });
      const receipt = addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:resume', capability: 'run_tools', risk: 'high', status: 'completed', detail: 'The owner resumed the explicitly granted computer-control permission.', source: 'desktop-bridge' });
      addActivity('security', 'The owner resumed agent computer control.');
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message }); return true; }
  }
  if (pathname === '/api/desktop-bridge/media/stop') {
    try {
      const kind = String(body.kind || 'all');
      const media = stopDesktopMediaKind(kind, 'owner-media-stop');
      const previousBridge = state.settings.desktopBridge;
      if (previousBridge?.linkId) {
        const stopped = kind === 'all' ? ['camera', 'microphone', 'speaker'] : [kind];
        state.settings.desktopBridge = {
          ...previousBridge,
          mediaGrants: { ...previousBridge.mediaGrants, ...Object.fromEntries(stopped.map((item) => [item, false])) },
          mediaPausedByOwner: { ...previousBridge.mediaPausedByOwner, ...Object.fromEntries(stopped.map((item) => [item, true])) }
        };
      }
      if (['microphone', 'speaker', 'all'].includes(kind)) endVoiceCall('', `owner-${kind}-stop`);
      if (['microphone', 'speaker', 'all'].includes(kind)) { avatarPresence?.hide(`owner-${kind}-stop`); onRequestPresence?.deactivate(`owner-${kind}-stop`); }
      const connection = state.agentLinks.find((item) => item.id === state.settings.desktopBridge?.linkId && item.status === 'connected');
      const detail = `The owner stopped ${kind === 'camera' ? 'camera sharing' : kind === 'microphone' ? 'microphone sharing' : kind === 'speaker' ? 'agent speaker output' : 'all camera, microphone, and speaker sharing'} for this session.`;
      if (connection) queueAgentLinkEvent(connection, { type: 'desktop.media.stopped', text: detail, metadata: { kind } });
      const receipt = addReceipt({ agentId: state.agentLinks.find((item) => item.id === state.settings.desktopBridge?.linkId)?.agentId || null, action: `desktop-bridge:media-stop:${kind}`, capability: 'emergency_stop', risk: 'high', status: 'completed', detail, source: 'desktop-bridge' });
      addActivity('security', detail);
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), media, receipt }); return true;
    } catch (error) { json(res, error.status || 400, { error: error.message, media: publicDesktopMedia() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/media/switch') {
    const kind = String(body.kind || '');
    const capability = { camera: 'camera-view', microphone: 'microphone-listen', speaker: 'speaker-output' }[kind];
    if (!capability || typeof body.enabled !== 'boolean') { json(res, 400, { error: 'Choose one media switch and an explicit on/off state.' }); return true; }
    const callSelected = publicVoiceCall();
    const inCall = ['offered', 'ringing', 'active'].includes(callSelected.status);
    const bridge = inCall ? callMediaBridge(state) : state.settings.desktopBridge;
    const connection = state.agentLinks.find((item) => item.id === bridge?.linkId && item.status === 'connected');
    if (!bridge?.enabled || !connection) { json(res, 409, { error: 'Start computer access for a connected Link first.' }); return true; }
    if (body.enabled && !hasApprovedCapability(connection, capability)) { json(res, 403, { error: `This Link was not granted ${capability}.` }); return true; }
    if (body.enabled) {
      const denied = connectorPolicy(inCall ? 'conversation' : 'run_tools', 'high', body.approved === true);
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
    }
    try {
      const media = setDesktopMediaKind(connection.id, kind, body.enabled);
      if (body.enabled && !hasCapability(connection, capability)) connection.capabilities.push(capability);
      const session = desktopBridgeSession(state.settings.desktopBridge, connection.id);
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, {
        mediaGrants: { ...session.mediaGrants, [kind]: body.enabled },
        mediaPausedByOwner: { ...session.mediaPausedByOwner, [kind]: !body.enabled }
      });
      if (!body.enabled && ['microphone', 'speaker'].includes(kind)) {
        endVoiceCall(connection.id, 'owner-media-off');
        avatarPresence?.hide('owner-media-off');
        onRequestPresence?.deactivate('owner-media-off');
      }
      const detail = `The owner turned ${kind} ${body.enabled ? 'on' : 'off'} for this computer-access session.`;
      queueAgentLinkEvent(connection, { type: 'desktop.media.switched', text: detail, metadata: { kind, enabled: body.enabled } });
      const receipt = addReceipt({ agentId: connection.agentId, action: `desktop-bridge:media-switch:${kind}`, capability, risk: body.enabled ? 'high' : 'medium', status: 'completed', detail, source: 'desktop-bridge' });
      await saveState();
      json(res, 200, { media, bridge: publicDesktopBridge(state.settings.desktopBridge), receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, media: publicDesktopMedia() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/media/camera-state') {
    try {
      const bridge = callMediaBridge(state);
      const connection = state.agentLinks.find((item) => item.id === bridge.linkId && item.status === 'connected');
      if (!hasCapability(connection, 'camera-view')) { json(res, 403, { error: 'This link was not paired with camera viewing.' }); return true; }
      const enabled = body.enabled === true;
      const media = setDesktopCameraEnabled(bridge.linkId, enabled);
      if (state.settings.desktopBridge.linkId === bridge.linkId) state.settings.desktopBridge = {
        ...state.settings.desktopBridge,
        mediaGrants: { ...state.settings.desktopBridge.mediaGrants, camera: enabled },
        mediaPausedByOwner: { ...state.settings.desktopBridge.mediaPausedByOwner, camera: !enabled }
      };
      const detail = enabled ? 'The owner resumed session-only camera sharing.' : 'The owner paused session-only camera sharing.';
      queueAgentLinkEvent(connection, { type: enabled ? 'desktop.camera.resumed' : 'desktop.camera.paused', text: detail, metadata: {} });
      const receipt = addReceipt({ agentId: connection.agentId, action: enabled ? 'desktop-bridge:camera-resume' : 'desktop-bridge:camera-pause', capability: 'camera-view', risk: 'high', status: 'completed', detail, source: 'desktop-bridge' });
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(state.settings.desktopBridge), media, receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, media: publicDesktopMedia() }); return true; }
  }
  if (['/api/desktop-bridge/voice-call/accept', '/api/desktop-bridge/voice-call/decline'].includes(pathname)) {
    try {
      const result = await applyOwnerIncomingVoiceCallAction({ state, callId: body.callId, action: pathname.endsWith('/accept') ? 'accept' : 'decline', connectorPolicy, addReceipt, saveState, onVoiceCallStarted });
      json(res, 200, result); return true;
    } catch (error) { json(res, error.status || 409, { ...(error.policyDecision || {}), error: error.message, voiceCall: publicVoiceCall() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/voice-call/add' || pathname === '/api/desktop-bridge/voice-call/select') {
    try {
      const device = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'conversation', action: 'call device' });
      if (!device.ownerApproved) throw Object.assign(new Error('The owner has not approved this call device.'), { status: 403 });
      const connection = state.agentLinks.find(item => item.id === String(body.linkId || '') && item.status === 'connected');
      if (!connection || !hasApprovedCapability(connection, 'microphone-listen') || !hasApprovedCapability(connection, 'speaker-output')) throw Object.assign(new Error('This agent needs approved microphone and speaker access.'), { status: 403 });
      const denied = connectorPolicy('conversation', 'high', body.approved);
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const previous = publicVoiceCall();
      if (previous.status !== 'active') throw Object.assign(new Error('Start a call before adding another agent.'), { status: 409 });
      if (pathname.endsWith('/add')) {
        const invited = startVoiceCall({ linkId: connection.id, microphoneGranted: true, speakerGranted: true, allowAdd: true });
        connection.capabilities = [...new Set([...connection.capabilities, 'microphone-listen', 'speaker-output'])];
        queueAgentLinkEvent(connection, { type: 'voice.call.offered', text: 'The owner added you to a private call. Answer, then stay on hold until the owner selects you. Do not read or reply to call audio while on hold.', metadata: { callId: invited.id, mediaEpoch: invited.mediaEpoch, onHold: true } });
        addReceipt({ agentId: connection.agentId, action: 'voice-call:add', capability: 'conversation', risk: 'high', status: 'completed', detail: 'The owner added an already-granted agent on hold; no audio or video was shared.', source: 'voice-call' });
        await saveState(); json(res, 201, { voiceCall: publicVoiceCall() }); return true;
      }
      const voiceCall = selectVoiceCall(connection.id);
      resumeOwnerCallMedia(state, connection);
      setVoiceCallMicrophoneSequenceStart(connection.id, nextDesktopMicrophoneSequence(connection.id));
      onVoiceCallStarted?.(voiceCall);
      const previousConnection = state.agentLinks.find(item => item.id === previous.linkId && item.status === 'connected');
      if (previousConnection) queueAgentLinkEvent(previousConnection, { type: 'voice.call.held', text: 'The owner put you on hold. Audio and video are paused until selected.', metadata: { callId: previous.id } });
      queueAgentLinkEvent(connection, { type: 'voice.call.resumed', text: 'The owner selected you. You are the only agent receiving call audio and video.', metadata: { callId: voiceCall.id, mediaEpoch: voiceCall.mediaEpoch } });
      addReceipt({ agentId: connection.agentId, action: 'voice-call:select', capability: 'conversation', risk: 'high', status: 'completed', detail: 'The owner selected one call participant; the previous participant was put on hold and its audio queue cleared. Computer-control grants were not transferred.', source: 'voice-call' });
      await saveState(); json(res, 200, { voiceCall, callBridge: callMediaBridge(state), media: publicDesktopMedia() }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message }); return true; }
  }
  if (pathname === '/api/desktop-bridge/voice-call/start') {
    try {
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'conversation', action: 'call device' });
      if (!bridge.ownerApproved) throw Object.assign(new Error('The owner has not approved this call device.'), { status: 403 });
      const connection = state.agentLinks.find((item) => item.id === String(body.linkId || bridge.linkId) && item.status === 'connected');
      const required = ['microphone-listen', 'speaker-output', ...(body.video === true ? ['camera-view'] : [])];
      const missing = required.find(capability => !hasApprovedCapability(connection, capability));
      if (missing) { json(res, 403, { error: `Allow ${missing === 'camera-view' ? 'camera' : missing === 'microphone-listen' ? 'microphone' : 'speaker'} access for this agent before calling.` }); return true; }
      const denied = connectorPolicy('conversation', 'high', body.approved === true);
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const voiceCall = startVoiceCall({ linkId: connection.id, microphoneGranted: true, speakerGranted: true });
      resumeOwnerCallMedia(state, connection, body.video === true);
      setVoiceCallMicrophoneSequenceStart(connection.id, nextDesktopMicrophoneSequence(connection.id));
      onVoiceCallStarted?.(voiceCall);
      if (avatarPresence?.status().visible) avatarPresence.setState('listening');
      queueAgentLinkEvent(connection, { type: 'voice.call.offered', text: 'The owner started a private voice call.', metadata: { callId: voiceCall.id, mediaEpoch: voiceCall.mediaEpoch, offeredAt: voiceCall.offeredAt } });
      const receipt = addReceipt({ agentId: connection.agentId, action: 'voice-call:start', capability: 'conversation', risk: 'high', status: 'completed', detail: `The owner started a session-only voice call with ${connection.identity.name}.`, source: 'voice-call' });
      addActivity('agent-link', `Voice call offered to ${connection.identity.name}.`);
      await saveState();
      json(res, 201, { voiceCall, callBridge: callMediaBridge(state), receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, voiceCall: publicVoiceCall() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/presence/wake') {
    try {
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: body.linkId || state.settings.desktopBridge?.linkId, capability: 'desktop-view', action: 'on-request-presence' });
      const connection = state.agentLinks.find((item) => item.id === bridge.linkId && item.status === 'connected');
      const media = publicDesktopMedia();
      const allowed = hasCapability(connection, 'microphone-listen') && hasCapability(connection, 'speaker-output') && media.linkId === bridge.linkId && media.microphoneGranted && media.speakerGranted;
      if (!allowed) {
        json(res, 403, { error: 'Presence needs this exact Hexonaut to have session-only microphone listening and agent audio. No call or capture was started.', degraded: true, presence: onRequestPresence?.status() || null }); return true;
      }
      const agent = findAgent(connection.agentId) || null;
      let voiceCall = publicVoiceCall();
      if (!['offered', 'active'].includes(voiceCall.status)) {
        clearDesktopMicrophone(bridge.linkId);
        voiceCall = startVoiceCall({ linkId: bridge.linkId, microphoneGranted: true, speakerGranted: true,
          microphoneSequenceStart: nextDesktopMicrophoneSequence(bridge.linkId) });
      }
      else if (voiceCall.linkId !== bridge.linkId) throw Object.assign(new Error('Another Hexonaut already has the active voice call.'), { status: 409 });
      const avatar = avatarPresence.start({ agentId: agent?.id || connection.agentId || '', state: 'listening' });
      const presence = onRequestPresence.activate({ linkId: bridge.linkId, agentId: agent?.id || connection.agentId || '' });
      onVoiceCallStarted?.(voiceCall);
      queueAgentLinkEvent(connection, { type: 'voice.call.offered', text: 'The owner requested your presence with their local wake phrase.', metadata: { callId: voiceCall.id, mediaEpoch: voiceCall.mediaEpoch, offeredAt: voiceCall.offeredAt, onRequest: true } });
      const receipt = addReceipt({ agentId: connection.agentId, action: 'presence:wake', capability: 'conversation', risk: 'medium', status: 'completed', detail: `${connection.identity.name}'s on-request presence opened with the existing microphone and speaker grants.`, source: 'presence' });
      await saveState();
      json(res, 201, { presence, voiceCall, avatar, receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, degraded: true, presence: onRequestPresence?.status() || null, voiceCall: publicVoiceCall() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/presence/recede') {
    try {
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'desktop-view', action: 'on-request-presence' });
      if (onRequestPresence?.status().active && onRequestPresence.status().linkId !== bridge.linkId) throw Object.assign(new Error('This presence belongs to another Hexonaut.'), { status: 403 });
      const presence = await onRequestPresence.recede(String(body.reason || 'owner-ended').slice(0, 80));
      json(res, 200, { presence, voiceCall: publicVoiceCall(), avatar: avatarPresence.status(), media: publicDesktopMedia() }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, presence: onRequestPresence?.status() || null }); return true; }
  }
  if (pathname === '/api/desktop-bridge/voice-call/mute') {
    try {
      const bridge = callMediaBridge(state);
      const voiceCall = muteVoiceCall(bridge.linkId, body.muted !== false);
      if (voiceCall.ownerMuted) { clearDesktopSpeaker(bridge.linkId); clearDesktopMicrophone(bridge.linkId); }
      const connection = state.agentLinks.find((item) => item.id === bridge.linkId && item.status === 'connected');
      if (connection) queueAgentLinkEvent(connection, { type: voiceCall.ownerMuted ? 'voice.call.muted' : 'voice.call.unmuted', text: voiceCall.ownerMuted ? 'The owner muted the call.' : 'The owner unmuted the call.', metadata: { callId: voiceCall.id } });
      const receipt = addReceipt({ agentId: connection?.agentId || null, action: voiceCall.ownerMuted ? 'voice-call:mute' : 'voice-call:unmute', capability: 'conversation', risk: 'medium', status: 'completed', detail: voiceCall.ownerMuted ? 'The owner muted microphone delivery and agent playback.' : 'The owner resumed call audio.', source: 'voice-call' });
      await saveState();
      json(res, 200, { voiceCall, receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, voiceCall: publicVoiceCall() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/voice-call/end') {
    try {
      if (body.callId && body.callId !== publicVoiceCall().id) throw Object.assign(new Error('This call invitation is stale.'), { status: 409 });
      const previous = publicVoiceCall();
      const connection = state.agentLinks.find((item) => item.id === previous.linkId && item.status === 'connected');
      const requestedPresence = onRequestPresence?.status().active && onRequestPresence.status().linkId === previous.linkId;
      const voiceCall = endVoiceCall('', 'owner-ended');
      if (requestedPresence) pauseDesktopAudio(previous.linkId, 'voice-call-ended');
      else pauseDesktopMediaKind('all', 'voice-call-ended');
      avatarPresence?.hide('voice-call-ended');
      onRequestPresence?.deactivate('voice-call-ended');
      for (const participant of previous.participants || []) {
        const recipient = state.agentLinks.find(item => item.id === participant.linkId && item.status === 'connected');
        if (recipient) queueAgentLinkEvent(recipient, { type: 'voice.call.ended', text: 'The owner ended the voice call.', metadata: { callId: participant.id, reason: voiceCall.stopReason } });
      }
      const original = state.settings.desktopBridge;
      if (original?.enabled && publicDesktopMedia().linkId !== original.linkId) {
        startDesktopMedia({ linkId: original.linkId, cameraGranted: original.mediaGrants.camera, microphoneGranted: original.mediaGrants.microphone, speakerGranted: original.mediaGrants.speaker, preserveSequences: true });
        pauseDesktopMediaKind('all', 'voice-call-ended');
      }
      const receipt = addReceipt({ agentId: connection?.agentId || null, action: 'voice-call:end', capability: 'emergency_stop', risk: 'high', status: 'completed', detail: 'The owner ended the call and stopped active camera plus both audio streams. Approved media access remains available for the next call.', source: 'voice-call' });
      await saveState();
      json(res, 200, { voiceCall, media: publicDesktopMedia(), receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, voiceCall: publicVoiceCall() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/voice-call/interrupt') {
    try {
      const bridge = callMediaBridge(state);
      const result = interruptVoiceCall(bridge.linkId, { energy: body.energy });
      if (!result.interrupted) { json(res, 202, result); return true; }
      clearDesktopSpeaker(bridge.linkId);
      if (avatarPresence?.status().visible) avatarPresence.setState('listening');
      const connection = state.agentLinks.find((item) => item.id === bridge.linkId && item.status === 'connected');
      if (connection) queueAgentLinkEvent(connection, { type: 'voice.call.interrupted', text: 'The owner started speaking, so the unplayed reply was dropped.', metadata: { callId: result.voiceCall.id, interruptionCount: result.voiceCall.interruptionCount } });
      const receipt = addReceipt({ agentId: connection?.agentId || null, action: 'voice-call:interrupt', capability: 'conversation', risk: 'medium', status: 'completed', detail: 'Owner speech interrupted agent playback; queued audio was cleared and the call returned to listening.', source: 'voice-call' });
      await saveState();
      json(res, 200, { ...result, receipt }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, voiceCall: publicVoiceCall() }); return true; }
  }
  if (pathname === '/api/desktop-bridge/media') {
    try {
      const bridge = callMediaBridge(state);
      const result = readDesktopSpeaker(bridge.linkId, body.afterSpeakerSequence);
      const voiceCall = publicVoiceCall();
      if (result.speaker?.length) console.info('[HexiGrid voice audio] owner media endpoint delivered chunks', { count: result.speaker.length, firstSequence: result.speaker[0]?.sequence, lastSequence: result.speaker.at(-1)?.sequence, callStatus: voiceCall.status });
      json(res, 200, { ...result, voiceCall: voiceCall.linkId === bridge.linkId ? voiceCall : { status: 'idle', phase: 'idle' } }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, media: publicDesktopMedia(), speaker: [] }); return true; }
  }
  if (pathname === '/api/desktop-bridge/input') {
    try {
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'desktop-control', action: 'input' });
      enforceDesktopRateLimit(bridge.linkId, 'input');
      const authorize = () => {
        const current = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: bridge.linkId, capability: 'desktop-control', action: 'input' });
        if (body.input?.kind === 'text.type') desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: bridge.linkId, capability: 'desktop-type', action: 'text input' });
        return current;
      };
      const result = await coordinateDesktopRequest({ linkId: `owner:${bridge.linkId}`, authorize }, validate => dispatchDesktopInput(body.input, { authorize: validate }));
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, bridge.linkId, { lastActionAt: result.actedAt });
      await saveState();
      json(res, 200, { result, bridge: publicDesktopBridge(state.settings.desktopBridge) }); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message }); return true; }
  }
  if (pathname === '/api/desktop-bridge/media/camera' || pathname === '/api/desktop-bridge/media/microphone') {
    try {
      const bridge = callMediaBridge(state);
      const voiceCall = publicVoiceCall();
      if (body.callId && (body.callId !== voiceCall.id || body.mediaEpoch !== voiceCall.mediaEpoch || voiceCall.status !== 'active')) throw Object.assign(new Error('This capture belongs to an earlier call selection.'), { status: 409 });
      if (voiceCall.participants?.length > 1 && !body.callId) throw Object.assign(new Error('The active call identity is required for multi-agent capture.'), { status: 409 });
      if (pathname.endsWith('/microphone') && voiceCall.linkId === bridge.linkId && ['offered', 'ringing', 'active'].includes(voiceCall.status) && (voiceCall.status !== 'active' || voiceCall.ownerMuted)) {
        json(res, 202, { muted: true, media: publicDesktopMedia(), voiceCall }); return true;
      }
      const result = pathname.endsWith('/camera') ? publishCameraFrame(bridge.linkId, body) : publishMicrophoneChunk(bridge.linkId, body);
      if (pathname.endsWith('/microphone') && localTranscriber) {
        const connection = state.agentLinks.find((item) => item.id === bridge.linkId && item.status === 'connected');
        const activeCall = voiceCall.linkId === bridge.linkId && voiceCall.status === 'active' && !voiceCall.ownerMuted;
        if (connection) result.transcription = localTranscriber.enqueue(connection, { ...body, sequence: result.sequence }, (event) => {
          const liveCall = publicVoiceCall();
          // Recognition may finish after hang-up, mute, or a different call.
          // Such results must never enter the new call or the agent's intake.
          if (activeCall && (liveCall.id !== voiceCall.id || liveCall.mediaEpoch !== voiceCall.mediaEpoch || liveCall.status !== 'active' || liveCall.ownerMuted || liveCall.linkId !== connection.id)) return;
          if (activeCall) event = { ...event, metadata: { ...event.metadata, callId: voiceCall.id, mediaEpoch: voiceCall.mediaEpoch } };
          if (activeCall && liveCall.status === 'active' && !liveCall.ownerMuted && liveCall.linkId === connection.id) {
            onVoiceTranscript?.({ linkId: connection.id, call: liveCall, event });
          }
          queueAgentLinkEvent(connection, event);
          if (event?.type === 'speech.transcript.final') {
            onRequestPresence?.activity(connection.id);
            if (avatarPresence?.status().visible) avatarPresence.setState('thinking');
            if (isPresenceFarewell(event.text) && onRequestPresence?.status().active) void onRequestPresence.recede('farewell');
          }
          void saveState();
        }, { activeCall });
      }
      json(res, 202, result); return true;
    } catch (error) { json(res, error.status || 409, { error: error.message, media: publicDesktopMedia() }); return true; }
  }
  json(res, 404, { error: 'Desktop bridge endpoint not found.' }); return true;
}

export function desktopBridgeFramePayload(frame) { return publicFrame(frame); }
