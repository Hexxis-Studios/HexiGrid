import crypto from 'node:crypto';

// A delivery adapter for the existing call. It never supplies agent cognition,
// reads other chats, or stores audio. Browser access is bound by the owner.
export class CallBrowserBridge {
  constructor({ authorize, receipt = () => {}, clock = Date.now }) {
    this.authorize = authorize; this.receipt = receipt; this.clock = clock;
    this.clients = new Map(); this.turns = new Map();
  }

  publish(binding, call, event) {
    const wake = event?.type === 'voice.call.wake';
    if (!binding?.enabled || (!wake && (event?.type !== 'speech.transcript.final' ||
        event.metadata?.source !== 'owner-microphone')) || event.metadata?.callId !== call?.id ||
        !String(event.text || '').trim()) return false;
    this.prune();
    const client = this.clients.get(binding.id);
    const mediaEpoch = Number(call.mediaEpoch || 0);
    if (!client || !this.authorize(binding, call.id, mediaEpoch, wake ? 'wake' : 'speech')) return false;
    if (wake && [...this.turns.values()].some(t => t.bindingId === binding.id && t.callId === call.id && t.kind === 'wake')) return false;
    if ([...this.turns.values()].filter(t => t.bindingId === binding.id && t.status === 'offered').length >= 8) {
      this.receipt(binding, 'failed', 'Chat delivery is busy. The spoken text remains in local call history.'); return false;
    }
    const turn = { id: crypto.randomUUID(), bindingId: binding.id, callId: call.id, mediaEpoch, kind: wake ? 'wake' : 'speech',
      text: String(event.text).trim().slice(0, 20_000), status: 'offered', createdAt: this.clock() };
    this.turns.set(turn.id, turn);
    if (!client.write(`event: utterance\ndata: ${JSON.stringify({ id: turn.id, callId: turn.callId, mediaEpoch, kind: turn.kind, text: turn.text })}\n\n`)) {
      turn.status = 'uncertain'; turn.text = ''; this.receipt(binding, 'failed', 'The chat connection stopped before delivery could be confirmed.');
    }
    return true;
  }

  wake(binding, call) {
    return this.publish(binding, call, { type: 'voice.call.wake', metadata: { callId: call.id }, text: callWakeMessage(call) });
  }

  subscribe(binding, res) {
    this.clients.get(binding.id)?.end();
    this.clients.set(binding.id, res);
    res.once('close', () => { if (this.clients.get(binding.id) === res) this.clients.delete(binding.id); });
  }

  claim(binding, id) {
    this.prune();
    const turn = this.turns.get(id);
    if (!turn || turn.bindingId !== binding.id || turn.status !== 'offered' || !this.authorize(binding, turn.callId, turn.mediaEpoch, turn.kind)) {
      throw Object.assign(new Error('This spoken turn is no longer available for this chat.'), { status: 409 });
    }
    turn.status = 'dispatching';
    return { id: turn.id, callId: turn.callId, mediaEpoch: turn.mediaEpoch, kind: turn.kind, text: turn.text };
  }

  report(binding, id, status) {
    const turn = this.turns.get(id);
    if (!turn || turn.bindingId !== binding.id || turn.status !== 'dispatching' || !['submitted', 'failed', 'uncertain'].includes(status)) {
      throw Object.assign(new Error('The chat delivery receipt is invalid or already recorded.'), { status: 409 });
    }
    turn.status = status; turn.text = '';
    this.receipt(binding, status === 'submitted' ? 'completed' : 'failed', status === 'submitted'
      ? 'A spoken turn was submitted to the selected agent chat. An agent reply is still required.'
      : 'A spoken turn could not be confirmed in the selected chat. It will not be resent automatically.');
    return { status };
  }

  canDispatch(binding, callId, mediaEpoch) {
    this.prune();
    const turn = [...this.turns.values()].find(t => t.bindingId === binding.id && t.callId === callId &&
      t.mediaEpoch === Number(mediaEpoch || 0) && t.status === 'dispatching');
    return Boolean(turn && this.authorize(binding, callId, mediaEpoch, turn.kind));
  }

  disconnect(bindingId) {
    this.clients.get(bindingId)?.end(); this.clients.delete(bindingId);
    for (const [id, turn] of this.turns) if (turn.bindingId === bindingId) this.turns.delete(id);
  }

  prune() {
    for (const [id, turn] of this.turns) if (this.clock() - turn.createdAt > 60_000 || !this.authorize({ id: turn.bindingId }, turn.callId, turn.mediaEpoch, turn.kind)) this.turns.delete(id);
  }
}

export function validateCallChatSelection(input) {
  const url = new URL(String(input.url || ''));
  // The owner selects the conversation, including a side chat. Pin that exact
  // selection; do not navigate to a main chat or silently choose a destination.
  if (url.origin !== 'https://muse.ai' || url.username || url.password || input.provider !== 'muse' ||
      !(url.pathname === '/' || /^\/thread\/[a-f0-9-]{36}$/.test(url.pathname)) || url.search || url.hash ||
      !String(input.title || '').trim() || String(input.title).length > 180 || !String(input.linkId || '').trim() ||
      [...url.searchParams.keys()].some(key => /token|secret|password|credential|auth/i.test(key))) {
    throw new Error('Choose the Muse conversation you want to use for calls before connecting it.');
  }
  return { provider: 'muse', url: url.href, title: input.title, linkId: input.linkId,
    label: String(input.label || 'Calls').trim().slice(0, 80) || 'Calls' };
}

export function callChatAuthorized({ state, selection, call, media, policyDenied = false, kind = 'speech', bindings = state?.settings.callBrowserBindings }) {
  const binding = bindings?.find(x => x.id === selection.id && x.enabled);
  const link = state?.agentLinks.find(x => x.id === binding?.linkId && x.status === 'connected');
  const device = state?.settings.desktopBridge;
  return Boolean(binding && link?.capabilities.includes('microphone-listen') && link.capabilities.includes('speaker-output') &&
    device?.enabled && device.ownerApproved && media?.linkId === link.id && media.microphoneGranted && media.speakerGranted &&
    (call?.status === 'active' || (kind === 'wake' && call?.status === 'offered' && call.direction === 'owner-to-agent')) && !call.ownerMuted && call.id === selection.callId && call.linkId === link.id &&
    (selection.mediaEpoch === undefined ? !Number(call.mediaEpoch || 0) : selection.mediaEpoch === Number(call.mediaEpoch || 0)) && !policyDenied);
}

export function callWakeMessage(call) {
  return `HexiGrid call ${call.id} (media epoch ${Number(call.mediaEpoch || 0)}): ${call.status === 'offered' ? 'Your paired owner is calling you. Read voice-call-status and answer this exact call with voice-call-answer.' : 'Your paired owner accepted the call.'} Use your existing Link and identity. For this call, each owner sentence will arrive here as a message to wake one turn. Read the current call status, then respond with your own voice using voice-call-reply --call-id ${call.id} --media-epoch ${Number(call.mediaEpoch || 0)}. Keep the call open between replies. Do not keep a thinking turn or polling loop running when this message-driven delivery is connected. Stop replying when the call ends, is muted, held or revoked. This call notice does not grant any new permission.`;
}
