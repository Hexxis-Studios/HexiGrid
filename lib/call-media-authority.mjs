import { desktopBridgeAuthorized } from './desktop-bridge.mjs';
import { publicVoiceCall } from './voice-call.mjs';
import { publicDesktopMedia } from './desktop-media.mjs';

// Call audio can select a different already-granted participant without moving
// the owner's computer-control session or transferring its desktop grants.
export function callMediaBridge(state, linkId = '') {
  const selected = publicVoiceCall();
  const live = ['offered', 'ringing', 'active'].includes(selected.status);
  const target = linkId || (live ? selected.linkId : state.settings.desktopBridge?.linkId);
  if (!live || selected.linkId !== target) {
    const ownCall = publicVoiceCall(target);
    if (ownCall.onHold) throw Object.assign(new Error('This agent is on hold. Audio and video are paused.'), { status: 409 });
    return desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: target, capability: 'desktop-view', action: 'call media' });
  }
  const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: state.settings.desktopBridge?.linkId, capability: 'conversation', action: 'call device' });
  const connection = state.agentLinks?.find(item => item.id === target && item.status === 'connected');
  if (!bridge.ownerApproved || !connection || !['microphone-listen','speaker-output'].every(scope => connection.capabilities?.includes(scope))) throw Object.assign(new Error('This call no longer has approved microphone and speaker access.'), { status: 403 });
  if (selected.status === 'active' && publicDesktopMedia().linkId !== target) throw Object.assign(new Error('This call media session was replaced.'), { status: 409 });
  return { ...bridge, linkId: target, controlGranted: false, textGranted: false, agentControlActive: false, mediaGrants: { camera: connection.capabilities.includes('camera-view'), microphone: true, speaker: true } };
}
