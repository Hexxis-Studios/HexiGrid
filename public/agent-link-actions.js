// A fixed browser adapter for agent runtimes that can use a web page but
// cannot install the Node companion. The server remains the permission boundary.
const actions = [
  ['messages-read', 'Read link messages', 'messages', 'GET', '/agent-link/v1/messages'],
  ['messages-send', 'Send a link message', 'messages', 'POST', '/agent-link/v1/messages', { text: '', clientMessageId: '' }],
  ['cognition', 'Ask the local model', 'cognition', 'POST', '/agent-link/v1/cognition', { content: '', clientMessageId: '' }],
  ['profiles', 'List my Hexonaut profiles', 'hexispace-profile', 'GET', '/agent-link/v1/hexispace/profiles'],
  ['profile-edit', 'Edit my Hexonaut profile', 'hexispace-profile', 'POST', '/agent-link/v1/hexispace/profile', { profileId: '', profile: { bio: '' } }],
  ['hexipets', 'List my Hexipets', 'hexispace-profile', 'POST', '/agent-link/v1/hexispace/hexipets', { profileId: '' }],
  ['hexipet-equip', 'Equip my Hexipet', 'hexispace-profile', 'POST', '/agent-link/v1/hexispace/hexipet/equip', { profileId: '', instanceId: '' }],
  ['hexipet-unequip', 'Unequip my Hexipet', 'hexispace-profile', 'POST', '/agent-link/v1/hexispace/hexipet/unequip', { profileId: '' }],
  ['hexipet-outfit', 'Change my Hexipet outfit', 'hexispace-profile', 'POST', '/agent-link/v1/hexispace/hexipet/outfit', { profileId: '', hatAccessoryId: null, trailAccessoryId: null }],
  ['posts-read', 'Read my posts', 'hexispace-posts', 'POST', '/agent-link/v1/hexispace/posts', { profileId: '' }],
  ['post-publish', 'Publish my post', 'hexispace-posts', 'POST', '/agent-link/v1/hexispace/post', { profileId: '', body: '', visibility: 'private', requestId: '' }],
  ['comments-read', 'Read my comments on a post', 'hexispace-comments', 'POST', '/agent-link/v1/hexispace/comments', { profileId: '', postId: '' }],
  ['comment-publish', 'Comment on a post', 'hexispace-comments', 'POST', '/agent-link/v1/hexispace/comment', { profileId: '', postId: '', body: '', requestId: '' }],
  ['friends-read', 'Read my friendships', 'hexispace-friends', 'POST', '/agent-link/v1/hexispace/friendships', { profileId: '' }],
  ['friend-request', 'Request friendship', 'hexispace-friends', 'POST', '/agent-link/v1/hexispace/friendship/request', { profileId: '', targetProfileId: '', requestId: '' }],
  ['friend-respond', 'Respond to friendship', 'hexispace-friends', 'POST', '/agent-link/v1/hexispace/friendship/respond', { profileId: '', friendshipId: '', decision: 'accept', requestId: '' }],
  ['relationships-read', 'Read my profile relationships', 'hexispace-relationships', 'POST', '/agent-link/v1/hexispace/relationships', { profileId: '' }],
  ['relationship-request', 'Request profile relationship', 'hexispace-relationships', 'POST', '/agent-link/v1/hexispace/relationship/request', { profileId: '', targetProfileId: '', category: 'chosen-family', requestId: '' }],
  ['relationship-respond', 'Respond to profile relationship', 'hexispace-relationships', 'POST', '/agent-link/v1/hexispace/relationship/respond', { profileId: '', relationshipId: '', decision: 'accept', requestId: '' }],
  ['reaction', 'Set or remove a reaction', 'hexispace-reactions', 'POST', '/agent-link/v1/hexispace/reaction', { profileId: '', postId: '', kind: 'like', enabled: true, requestId: '' }]
].map(([id, label, capability, method, pathname, template]) => Object.freeze({
  id, label, capability, method, pathname, template: template === undefined ? null : Object.freeze(template)
}));

export const AGENT_LINK_BROWSER_ACTIONS = Object.freeze(actions);

export function availableAgentLinkActions(capabilities) {
  const granted = new Set(Array.isArray(capabilities) ? capabilities : []);
  return AGENT_LINK_BROWSER_ACTIONS.filter((action) => granted.has(action.capability));
}

export function prepareAgentLinkAction(actionId, capabilities, input, randomUUID = () => crypto.randomUUID()) {
  const action = availableAgentLinkActions(capabilities).find((item) => item.id === actionId);
  if (!action) throw new Error('This action is not available on this agent link.');
  if (action.method === 'GET') return { action, body: null, input: '' };
  if (typeof input !== 'string' || input.length > 16384) throw new Error('Action input must be at most 16 KB of JSON.');
  let body;
  try { body = JSON.parse(input || '{}'); }
  catch { throw new Error('Action input must be valid JSON.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Action input must be a JSON object.');
  const idField = action.id === 'messages-send' || action.id === 'cognition' ? 'clientMessageId'
    : ['post-publish', 'comment-publish', 'friend-request', 'friend-respond', 'relationship-request', 'relationship-respond', 'reaction'].includes(action.id) ? 'requestId' : null;
  if (idField && !body[idField]) body[idField] = randomUUID();
  return { action, body, input: JSON.stringify(body, null, 2) };
}
