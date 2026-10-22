const STATES = new Set(['idle', 'listening', 'thinking', 'speaking']);
const FIELDS = new Set(['visible', 'state', 'yaw', 'scale', 'animation', 'playing', 'expectedRevision']);

export function publicAvatarPresence(agent) {
  const value = agent.avatarPresence || {};
  return { agentId: agent.id, visible: value.visible === true, state: STATES.has(value.state) ? value.state : 'idle', yaw: Number.isFinite(value.yaw) ? value.yaw : 0, scale: Number.isFinite(value.scale) ? value.scale : 1, animation: typeof value.animation === 'string' ? value.animation : '', animations: Array.isArray(agent.avatarAnimationNames) ? agent.avatarAnimationNames.slice(0, 100) : [], playing: value.playing !== false, revision: Number.isSafeInteger(value.revision) ? value.revision : 0 };
}

/** Shared owner/Link commit path. Callers enforce identity and effective policy first. */
export function updateAvatarPresence(agent, patch) {
  const current = publicAvatarPresence(agent);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !FIELDS.has(key))) throw new Error('Use only visible, state, yaw, scale, animation, playing and expectedRevision.');
  if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision !== current.revision) throw Object.assign(new Error('Avatar changed; read it again before updating.'), { status: 409 });
  for (const key of ['visible', 'playing']) if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  if ('state' in patch && !STATES.has(patch.state)) throw new Error('Choose idle, listening, thinking or speaking.');
  for (const [key, min, max] of [['yaw', -180, 180], ['scale', .25, 2]]) if (key in patch && (!Number.isFinite(patch[key]) || patch[key] < min || patch[key] > max)) throw new Error(`${key} must be between ${min} and ${max}.`);
  if ('animation' in patch && (typeof patch.animation !== 'string' || patch.animation.length > 120 || /[\x00-\x1f]/.test(patch.animation))) throw new Error('Animation must be a clip name of at most 120 characters.');
  const { expectedRevision, ...changes } = patch;
  agent.avatarPresence = { ...current, ...changes, revision: current.revision + 1 };
  return publicAvatarPresence(agent);
}
