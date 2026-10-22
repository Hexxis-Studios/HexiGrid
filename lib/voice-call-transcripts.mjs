const MAX_LINES = 40;
const MAX_TEXT = 1000;

/**
 * Short-lived owner transcript view for the floating call controls.
 * Nothing is written to disk; reads are scoped to the current active call and Link.
 */
export class VoiceCallTranscriptBuffer {
  #current = null;

  begin(call) {
    const callId = String(call?.id || '');
    const linkId = String(call?.linkId || '');
    this.#current = callId && linkId ? { callId, linkId, lines: [] } : null;
    return this.read({ call, linkId, enabled: true });
  }

  clear(callId = '') {
    if (!callId || this.#current?.callId === String(callId)) this.#current = null;
  }

  add({ linkId, call, event } = {}) {
    const current = this.#current;
    if (!current || String(linkId || '') !== current.linkId || String(call?.id || '') !== current.callId || call?.status !== 'active') return false;
    if (!['speech.transcript.partial', 'speech.transcript.final', 'speech.transcription.error'].includes(event?.type)) return false;
    const text = String(event.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) return false;
    if (event.type === 'speech.transcription.error') {
      current.lines.push({ text, final: true, status: true, speaker: 'Call status', at: new Date().toISOString() });
      current.lines = current.lines.slice(-MAX_LINES);
      return true;
    }
    if (event.type === 'speech.transcript.partial') {
      const last = current.lines.at(-1);
      if (last?.final !== true) current.lines.pop();
      current.lines.push({ text, final: false, speaker: 'You', at: new Date().toISOString() });
    } else {
      if (current.lines.at(-1)?.final === false) current.lines.pop();
      current.lines.push({ text, final: true, speaker: 'You', at: new Date().toISOString() });
    }
    current.lines = current.lines.slice(-MAX_LINES);
    return true;
  }

  read({ linkId, call, enabled = false } = {}) {
    const current = this.#current;
    if (!enabled || call?.status !== 'active' || !current || String(linkId || '') !== current.linkId || String(call.id || '') !== current.callId) return [];
    return current.lines.map(line => ({ ...line }));
  }
}
