import { publicAvatarPresence, updateAvatarPresence } from './avatar-presence.mjs';

/** Call activity drives the same local avatar record as the owner and signed Link. */
export class AvatarPresenceRuntime {
  constructor({ findAgent, currentAgentId = () => '', onChange = () => {}, setTimer = setTimeout, cancelTimer = clearTimeout }) {
    this.findAgent = findAgent; this.currentAgentId = currentAgentId; this.onChange = onChange;
    this.agentId = ''; this.timer = null;
    this.setTimer = setTimer; this.cancelTimer = cancelTimer;
  }
  agent() { return this.findAgent(this.agentId || this.currentAgentId()); }
  status() { const agent = this.agent(); return agent ? publicAvatarPresence(agent) : { visible: false, state: 'idle' }; }
  clearTimer() { this.cancelTimer(this.timer); this.timer = null; }
  commit(patch) {
    const agent = this.agent();
    if (!agent) return this.status();
    const result = updateAvatarPresence(agent, { ...patch, expectedRevision: publicAvatarPresence(agent).revision });
    this.onChange(result);
    return result;
  }
  start({ agentId, state = 'idle' }) {
    this.clearTimer();
    if (!this.findAgent(agentId)) throw new Error('Avatar agent not found.');
    this.agentId = agentId;
    return this.commit({ visible: true, state });
  }
  hide() { this.clearTimer(); return this.commit({ visible: false, state: 'idle' }); }
  setState(state) { this.clearTimer(); return this.commit({ state }); }
  setStateFor(state, nextState = 'listening', durationMs = 2500) {
    this.setState(state);
    const agentId = this.agent()?.id, revision = this.status().revision;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.agent()?.id === agentId && this.status().revision === revision && this.status().visible && this.status().state === state) this.commit({ state: nextState });
    }, Math.max(250, Math.min(30000, Number(durationMs) || 2500)));
    this.timer.unref?.();
  }
  stop() { this.clearTimer(); }
}
