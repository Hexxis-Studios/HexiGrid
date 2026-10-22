const timestamp = () => new Date().toISOString();
const cleanId = (value) => String(value || '').trim().slice(0, 160);

export function isPresenceFarewell(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  return /^(?:goodbye|bye|bye bye|good night|goodnight|talk to you later|see you later|that's all|that is all|you can go now|thanks,? goodbye)$/.test(text);
}

export class OnRequestPresenceController {
  constructor({ timeoutMs = 30_000, onRecede = async () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.timeoutMs = Math.max(2_000, Math.min(120_000, Number(timeoutMs) || 30_000));
    this.onRecede = onRecede;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.current = this.#blank();
  }

  #blank(reason = 'idle') {
    return { active: false, linkId: '', agentId: '', state: 'idle', startedAt: null, lastActivityAt: null, timeoutMs: this.timeoutMs, stopReason: reason };
  }

  status() { return { ...this.current }; }

  activate({ linkId, agentId = '' } = {}) {
    const id = cleanId(linkId);
    if (!id) throw new Error('Choose the connected Hexonaut before requesting presence.');
    const at = timestamp();
    this.#clearTimer();
    this.current = { active: true, linkId: id, agentId: cleanId(agentId), state: 'listening', startedAt: at, lastActivityAt: at, timeoutMs: this.timeoutMs, stopReason: '' };
    this.#schedule();
    return this.status();
  }

  activity(linkId) {
    if (!this.current.active || this.current.linkId !== cleanId(linkId)) return this.status();
    this.current = { ...this.current, lastActivityAt: timestamp() };
    this.#schedule();
    return this.status();
  }

  deactivate(reason = 'ended') {
    this.#clearTimer();
    this.current = this.#blank(String(reason || 'ended').slice(0, 80));
    return this.status();
  }

  async recede(reason = 'ended') {
    if (!this.current.active) return this.status();
    const active = this.status();
    this.deactivate(reason);
    await this.onRecede({ ...active, reason: String(reason || 'ended').slice(0, 80) });
    return this.status();
  }

  close() { this.deactivate('shutdown'); }

  #schedule() {
    this.#clearTimer();
    this.timer = this.setTimer(() => { this.timer = null; void this.recede('silence-timeout'); }, this.timeoutMs);
    this.timer?.unref?.();
  }

  #clearTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}
