import { desktopBridgeSession, updateDesktopBridgeSession, startDesktopBridge, coordinateDesktopRequest } from './desktop-bridge.mjs';
import { callMediaBridge } from './call-media-authority.mjs';
import path from 'node:path';
import { localUsageSnapshot, commitUsageBudget } from './usage-report.mjs';
import { acceptLinkedRoomReply } from './linked-room-chat.mjs';
import { publicAvatarPresence, updateAvatarPresence } from './avatar-presence.mjs';
import { handleLinkedTasks } from './agent-link-tasks.mjs';
import crypto from 'node:crypto';
import { normalizeContextScope, validateMemoryProposal } from './dated-memory.mjs';
import { createMemoryProposalService } from './memory-proposal-service.mjs';
import { createMemoryMistakeReader } from './memory-mistake-reader.mjs';
import { normalizeOwnerMemory } from './owner-memory.mjs';
import { captureOwnerMemoryCorrection, normalizeOwnerMemoryCaptureIntent, prepareOwnerMemoryCorrection } from './owner-memory-correction-service.mjs';
import { assertOwnerMemoryRetirementIdle, commitOwnerMemoryRetirement, commitOwnerMemoryRestoration, validateOwnerNoteRetirementRequest, validateOwnerNoteRestorationRequest } from './owner-memory-retirement-service.mjs';
import { acquireOwnerMemoryCaptureLock, commitOwnerMemoryCaptureDiscard, hasDiscardedOwnerMemoryCapture,
  hasPendingOwnerMemoryCapture, normalizeMemoryProposalState } from './memory-proposal-state.mjs';
import { buildSharedMemoryMistakeWarnings, canonicalRecordFromDatedEntry } from './memory-mistake-ledger.mjs';
import { consumeMemoryWriteBudget } from './memory-write-budget.mjs';
import { selectMemoryScopeForTurn, setCodexThreadMemoryScopeBinding } from './agent-link-memory-scope-bindings.mjs';

function hasCompletedOwnerMemoryCapture(record) {
  if (record?.kind !== 'owner-memory-correction' || record.status !== 'approved' ||
      record.ownerNoteCaptureState !== 'complete' || typeof record.ownerNoteMistakeId !== 'string') return false;
  try {
    const intent = normalizeOwnerMemoryCaptureIntent(record.ownerNoteCaptureIntent);
    return intent.agentId === record.agentId && intent.lineageId === record.lineageId &&
      intent.memoryId === record.payload?.memoryId && intent.source.linkId === record.linkId &&
      intent.expectedRevision === record.payload?.expectedRevision && intent.correctedContent === record.payload?.text &&
      intent.why === record.payload?.why && intent.expectedNextBehavior === record.payload?.expectedNextBehavior &&
      stableContinuityJson(intent.source) === stableContinuityJson(record.payload?.source);
  } catch { return false; }
}

function ownerNoteCaptureErrorNeedsStatus(error) {
  return error?.status === 403 || error?.status === 409 ||
    String(error?.code || '').startsWith('OWNER_NOTE_') ||
    String(error?.code || '').startsWith('owner_memory_correction_');
}

const LINK_SKILL_RISK_REASONS = new Set(['delayed_prompt_injection', 'high_confidence_ssn', 'payment_card_number']);
const LINK_SKILL_QUARANTINE_WARNING = '[QUARANTINED SKILL — excluded from current guidance; owner review required]';
const LINK_SKILL_VERSION_QUARANTINE_WARNING = '[QUARANTINED SKILL VERSION — owner review required]';

function boundedSkillRiskReasons(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((reason) => LINK_SKILL_RISK_REASONS.has(reason)))].slice(0, 4);
}

function linkSkillGuidanceView(skill) {
  const riskReasonCodes = boundedSkillRiskReasons(skill?.riskReasonCodes);
  if (!skill || !riskReasonCodes.length) return skill;
  return {
    id: skill.id,
    agentId: skill.agentId,
    lineageId: skill.lineageId,
    revision: skill.revision,
    name: '[Quarantined skill omitted]',
    whenToUse: '',
    procedure: '',
    successCheck: '',
    status: 'quarantined',
    provenance: skill.provenance,
    verification: skill.verification,
    warning: LINK_SKILL_QUARANTINE_WARNING,
    riskReasonCodes,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt
  };
}

function linkSkillHistoryView(history, { quarantineAll = false } = {}) {
  if (!history || !Array.isArray(history.revisions)) return history;
  return {
    ...history,
    revisions: history.revisions.map((revision) => {
      if (!quarantineAll && revision?.guidanceEligible !== false) return revision;
      return {
        revision: revision.revision,
        name: '[Quarantined skill version omitted]',
        whenToUse: '',
        procedure: '',
        successCheck: '',
        status: 'quarantined',
        at: revision.at,
        provenance: revision.provenance,
        verification: revision.verification,
        warning: LINK_SKILL_VERSION_QUARANTINE_WARNING,
        riskReasonCodes: boundedSkillRiskReasons(revision.riskReasonCodes),
        guidanceEligible: false
      };
    })
  };
}

export function signedMemoryMistakeReadGuard(ctx, connection, agent, lineageId) {
  const credential = connection.tokenHash;
  const linkId = connection.id;
  return () => {
    const current = ctx.state.agentLinks.find(item => item.id === linkId);
    const lineage = agent.continuityLineage;
    const active = ctx.state.agents.filter(item => item.continuityLineage?.id === lineageId && item.continuityLineage.activityState === 'active');
    if (!current || current.tokenHash !== credential || current.agentId !== agent.id || current.status !== 'connected' ||
      !Array.isArray(current.capabilities) || !current.capabilities.includes('memory-read') || ctx.findAgent(agent.id) !== agent ||
      lineage?.id !== lineageId || lineage.activityState !== 'active' || lineage.activeAgentId !== agent.id || active.length !== 1 || active[0] !== agent) {
      throw Object.assign(new Error('The exact Link memory-read authority is no longer active.'), { status: 403 });
    }
    const denied = ctx.connectorPolicy('read_local', 'medium', true, { external: true });
    if (denied) throw Object.assign(new Error('Current policy does not allow this private memory read.'), { status: denied.denied ? 403 : 409 });
    ctx.assertAgentActivity(agent);
  };
}

import { findActiveMemoryShare } from './memory-sharing.mjs';
import { createAgentSkill, currentAgentSkill, listAgentSkills, pageAgentSkillRevisions, reviseAgentSkill } from './agent-skills.mjs';
import { createAgentSkillQuarantineService } from './agent-skill-quarantine.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';
import { stableContinuityJson } from './continuity-transfer.mjs';
import { agentLinkSkillBundle } from './agent-link-skill-bundle.mjs';
import { agentLinkOrientation } from './agent-link-orientation.mjs';
import {
  acceptAgentLinkInvite,
  acknowledgeAgentLinkEvents,
  authenticateAgentLink,
  publicAgentLink,
  readAgentLinkConversation,
  readAgentLinkConversationPage,
  receiveAgentLinkMessage,
  recordAgentLinkHeartbeat,
  recordAgentLinkTokenMeasurement,
  requireAgentLinkCapability,
  saveAgentLinkContinuity,
  updateAgentLinkIdentity,
  waitForAgentLinkEvents,
  readAgentLinkEventPage,
  publicAgentLinkPairingFailure,
  toggleOwnerAgentLinkCapabilities,
  assertAgentLinkCapabilityUpdate,
  agentLinkPermissionPolicy,
  queueAgentLinkEvent
} from './agent-link.mjs';
import { listAgentLinkWorkspace, readAgentLinkWorkspaceFile, writeAgentLinkWorkspaceFile } from './agent-link-workspace.mjs';
import { listOwnerAgentDirectory, ownerAgentAuthorized, readOwnerAgentFile, runOwnerAgentProcess, writeOwnerAgentFile } from './owner-agent-access.mjs';
import { sanitizeVoiceProfile } from './live-communication.mjs';
import { actDesktopUia, captureDesktopFrame, desktopBridgeAuthorized, dispatchDesktopInput, enforceDesktopRateLimit, inspectDesktopUia, publicDesktopBridge, stopDesktopBridge } from './desktop-bridge.mjs';
import { ensureAgentCamera, setDesktopMediaKind, desktopMediaKindOwnerPaused, nextDesktopMicrophoneSequence, pauseDesktopAudio, pauseDesktopMediaKind, publicDesktopMedia, publishSpeakerChunk, readDesktopMedia, readDesktopMicrophone, waitForDesktopMicrophone, startDesktopMedia, stopDesktopMedia, stopDesktopMediaKind } from './desktop-media.mjs';
import { answerVoiceCall, endVoiceCall, initiateVoiceCall, publicVoiceCall, requireVoiceCall, setVoiceCallMicrophoneSequenceStart, voiceCallMicrophoneSequenceStart } from './voice-call.mjs';
import { publishVoiceReplyAudio, publishVoiceReplyText } from './voice-reply.mjs';
import { updateLinkedHexonautProfile } from './hexispace-agent-profile.mjs';
import {
  equipLinkedHexonautHexipet, listLinkedHexonautHexipets,
  setLinkedHexonautHexipetOutfit, unequipLinkedHexonautHexipet
} from './hexispace-agent-hexipet.mjs';
import { listLinkedHexonautPosts, publishLinkedHexonautPost } from './hexispace-agent-post.mjs';
import { listLinkedHexonautComments, publishLinkedHexonautComment } from './hexispace-agent-comment.mjs';
import {
  listLinkedHexonautFriendships, requestLinkedHexonautFriendship, respondLinkedHexonautFriendship,
  listLinkedHexonautRelationships, requestLinkedHexonautRelationship, respondLinkedHexonautRelationship,
  setLinkedHexonautReaction
} from './hexispace-agent-social.mjs';

function currentDesktopLinkAuthority(ctx, connection, { control = false, text = false } = {}) {
  const capability = control ? 'desktop-control' : 'desktop-view';
  const current = ctx.state.agentLinks.find(item => item.id === connection.id && item.tokenHash === connection.tokenHash && item.agentId === connection.agentId && item.status === 'connected' && Array.isArray(item.capabilities) && item.capabilities.includes(capability));
  if (!current) throw Object.assign(new Error('The exact desktop Link grant changed during the UI Automation request.'), { status: 403 });
  if (text && !current.capabilities.includes('desktop-type')) throw Object.assign(new Error('The exact desktop text grant changed during the UI Automation request.'), { status: 403 });
  const bridge = desktopBridgeAuthorized(ctx.state.settings.desktopBridge, { linkId: connection.id, capability, action: 'revalidate UI Automation authority' });
  if (text) desktopBridgeAuthorized(bridge, { linkId: connection.id, capability: 'desktop-type', action: 'revalidate UI Automation text authority' });
  const denied = ctx.connectorPolicy('run_tools', 'high', true);
  if (denied) throw Object.assign(new Error('Current policy no longer allows the UI Automation request.'), { status: denied.denied ? 403 : 409 });
  return bridge;
}

function desktopAuthorityGuard(ctx, connection, bridge, permissions) {
  const identity = { id: connection.id, agentId: connection.agentId, tokenHash: connection.tokenHash };
  const startedAt = bridge.startedAt;
  return () => {
    const current = currentDesktopLinkAuthority(ctx, identity, permissions);
    if (current.startedAt !== startedAt) throw Object.assign(new Error('The desktop session changed while this request was waiting. Inspect the current session before acting again.'), { status: 409, code: 'DESKTOP_SESSION_CHANGED' });
    return current;
  };
}

/**
 * Signed HexiGrid Link transport. Keeping pairing, signed events, cognition,
 * and continuity in one route boundary makes the connector's authorization
 * and receipt behavior auditable without growing server.mjs.
 */
export async function handleAgentLinkRequest(req, res, ctx) {
  const { state, pathname, method, readBody, json, html, serveStaticAsset, publicDir, securityHeaders, skillRoot, projectRoot, agentLinkWorkspaceRoot, findAgent, publicAgent, publicAgentLink, addReceipt, addActivity, saveState, localProfileReply, startHarnessJob, findHarnessJob, publicHarnessJob, cancelHarnessJob, stopHarnessJobsForLink, connectorPolicy, relayAgentLinkMessage, datedMemoryStore, localMemoryRag, getRetrievalMetrics, credentialVault, avatarPresence, onRequestPresence, agentLinkPairingLimiter, agentLinkPairingKey, cleanString, slug, id, now } = ctx;
  if (method === 'GET' && pathname === '/agent-link/connect') { await html(res, 'agent-link-connect.html'); return true; }
  if (method === 'GET' && pathname === '/agent-link/skill') {
    json(res, 200, await agentLinkSkillBundle(skillRoot, projectRoot || path.resolve(skillRoot, '..', '..')));
    return true;
  }
  if (method === 'GET' && ['/agent-link-connect.js', '/agent-link-actions.js', '/agent-link-browser-client.js', '/agent-link-relay-client.js', '/agent-link-connect.css', '/agent-link-media.css', '/brand-icosahedron.svg'].includes(pathname)) {
    await serveStaticAsset({ method, pathname, res, publicDir, securityHeaders, serveHtml: html });
    return true;
  }
  if (method === 'POST' && pathname === '/agent-link/v1/pair') {
    const pairingKey = String(agentLinkPairingKey?.(req) || req.socket?.remoteAddress || 'unknown');
    const currentLimit = agentLinkPairingLimiter?.check(pairingKey);
    if (currentLimit?.blocked) {
      json(res, 429, { error: 'Too many pairing attempts. Try again later.', code: 'pairing_rate_limited', retryAfter: currentLimit.retryAfter }, { 'retry-after': String(currentLimit.retryAfter) });
      return true;
    }
    try {
      const body = await readBody(req, 128 * 1024);
      const result = acceptAgentLinkInvite(state, body);
      let agent = result.connection.agentId ? findAgent(result.connection.agentId) : null;
      if (!agent && result.connection.identity.externalId) agent = state.agents.find((item) => item.bindings?.identities?.some((binding) => binding.framework === result.connection.identity.framework && binding.externalId === result.connection.identity.externalId));
      if (!agent) {
        const identity = result.connection.identity; const createdAt = now();
        agent = {
          id: id(slug(identity.name) || 'agent'), name: identity.name,
          accountLabel: identity.accountLabel || 'Agent profile', avatar: identity.avatar || identity.name.slice(0, 1).toUpperCase(), avatarImage: '', color: '#8d7dff',
          status: 'connected', transport: 'ilands-link', harness: '', ilandsAgentId: identity.framework.toLowerCase() === 'ilands' ? identity.externalId : '',
          externalEmail: '', runnerHome: '', workspacePath: '', personality: '',
          instructions: 'Preserve this agent’s verified identity and continuity. Use the selected HexiGrid model for local cognition and clearly distinguish local work from actions delivered to its original platform.',
          rules: 'Never claim an external action was completed without a matching connector receipt.',
          voiceProfile: sanitizeVoiceProfile({ engine: 'browser', voiceName: identity.voice?.name || '' }),
          model: state.settings.model, useGlobalCommunication: true, tags: [identity.framework, 'existing'],
          bindings: { identities: [{ framework: identity.framework, externalId: identity.externalId, linkId: result.connection.id, verifiedAt: now() }], cognition: { model: state.settings.model }, routes: [{ kind: 'agent-link', linkId: result.connection.id, priority: 1 }], tools: {}, devices: {} },
          createdAt, updatedAt: createdAt
        };
        agent.continuityLineage = { id: `lineage-${crypto.randomUUID()}`, generation: 0, activityState: 'active', activeAgentId: agent.id, createdAt, activatedAt: createdAt, suspendedAt: null, lastBackupId: null, restoredFromBackupId: null, restoredAt: null, sourceAgentId: null };
        state.agents.push(agent);
      } else {
        agent.bindings ||= { identities: [], cognition: { model: agent.model }, routes: [], tools: {}, devices: {} };
        if (!agent.bindings.identities.some((item) => item.linkId === result.connection.id)) agent.bindings.identities.push({ framework: result.connection.identity.framework, externalId: result.connection.identity.externalId, linkId: result.connection.id, verifiedAt: now() });
        if (!agent.bindings.routes.some((item) => item.linkId === result.connection.id)) agent.bindings.routes.push({ kind: 'agent-link', linkId: result.connection.id, priority: 1 });
        agent.status = 'connected'; agent.updatedAt = now();
      }
      result.connection.agentId = agent.id;
      const stored = state.agentLinks.find((item) => item.id === result.connection.id); if (stored) stored.agentId = agent.id;
      addReceipt({ agentId: agent.id, action: 'agent-link:pair', capability: 'external_write', risk: 'high', status: 'completed', detail: `${result.connection.identity.name} connected through a scoped HexiGrid Link and populated one canonical agent profile.`, source: 'agent-link' });
      addActivity('agent-link', `${result.connection.identity.name} connected through HexiGrid Link.`);
      await saveState();
      agentLinkPairingLimiter?.clear(pairingKey);
      json(res, 201, { connection: publicAgentLink(stored), agent: publicAgent(agent), orientation: agentLinkOrientation(stored, state.settings), token: result.token, tokenNotice: 'Store this token in a protected secret vault. It is shown only once.' });
    } catch (error) {
      const limit = agentLinkPairingLimiter?.recordFailure(pairingKey);
      if (limit?.blocked) json(res, 429, { error: 'Too many pairing attempts. Try again later.', code: 'pairing_rate_limited', retryAfter: limit.retryAfter }, { 'retry-after': String(limit.retryAfter) });
      else {
        const publicFailure = publicAgentLinkPairingFailure(error);
        json(res, publicFailure.status, { error: publicFailure.error, code: publicFailure.code });
      }
    }
    return true;
  }
  if (!pathname.startsWith('/agent-link/v1/')) return false;
  try {
    const body = (method === 'POST' || (method === 'PUT' && pathname === '/agent-link/v1/usage/budget')) ? await readBody(req, pathname === '/agent-link/v1/avatar/portrait' ? 1_650_000 : pathname === '/agent-link/v1/plugins/install' ? 14 * 1024 * 1024 : pathname === '/agent-link/v1/owner/fs/write' ? 900 * 1024 : pathname.endsWith('/continuity') ? 8 * 1024 * 1024 : pathname.endsWith('/desktop/speaker') || pathname === '/agent-link/v1/voice-call/reply' ? 1024 * 1024 : pathname.endsWith('/workspace/write') ? 1100 * 1024 : 256 * 1024) : null;
    const connection = authenticateAgentLink(state, req.headers.authorization, { method, pathname, body, timestamp: req.headers['x-hexigrid-timestamp'], nonce: req.headers['x-hexigrid-nonce'], signature: req.headers['x-hexigrid-signature'] });
    if (pathname === '/agent-link/v1/orientation' && method === 'GET') {
      json(res, 200, { orientation: agentLinkOrientation(connection, state.settings) }); return true;
    }
    if (pathname === '/agent-link/v1/addons/hexikeys' && method === 'GET') {
      await ctx.hexikeysRequest(req, res, 'status', {}, connection); return true;
    }
    const hexikeysAction = pathname.match(/^\/agent-link\/v1\/addons\/hexikeys\/(open|request-capture|connect|disconnect)$/);
    if (hexikeysAction && method === 'POST') {
      await ctx.hexikeysRequest(req, res, hexikeysAction[1], body, connection); return true;
    }
    const hexikeysPlugin = pathname.match(/^\/agent-link\/v1\/plugins\/([a-z0-9-]+)\/hexikeys-(scope|reference)$/);
    if (hexikeysPlugin && method === 'POST') {
      await ctx.hexikeysLinkedPluginRequest(req, res, hexikeysPlugin[1], hexikeysPlugin[2], body, connection); return true;
    }
    if (pathname === '/agent-link/v1/plugins' && method === 'GET') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-filesystem-read');
      const policy = connectorPolicy('read_local', 'high', false, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      json(res, 200, { plugins: ctx.pluginCatalog() }); return true;
    }
    if (pathname === '/agent-link/v1/plugin-publishers' && method === 'GET') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-filesystem-read');
      const denied = connectorPolicy('read_local', 'high', false, { external: true });
      if (denied) json(res, denied.denied ? 403 : 409, denied);
      else json(res, 200, { publishers: ctx.publisherCatalog() });
      return true;
    }
    const publisherRevoke = pathname.match(/^\/agent-link\/v1\/plugin-publishers\/([a-z0-9-]+)\/revoke$/);
    if (publisherRevoke && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.revokeLinkedPublisher(req, res, publisherRevoke[1], body, connection); return true;
    }
    if (pathname === '/agent-link/v1/plugins/install' && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.installLinkedPlugin(req, res, body, connection); return true;
    }
    const pluginRemove = pathname.match(/^\/agent-link\/v1\/plugins\/([a-z0-9-]+)\/remove$/);
    if (pluginRemove && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.removeLinkedPlugin(req, res, pluginRemove[1], body, connection);
      return true;
    }
    const pluginSecrets = pathname.match(/^\/agent-link\/v1\/plugins\/([a-z0-9-]+)\/secrets$/);
    if (pluginSecrets && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.setLinkedPluginCredentials(req, res, pluginSecrets[1], body, connection);
      return true;
    }
    const pluginEnable = pathname.match(/^\/agent-link\/v1\/plugins\/([a-z0-9-]+)\/enable$/);
    if (pluginEnable && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.enableLinkedPlugin(req, res, pluginEnable[1], body, connection);
      return true;
    }
    const pluginRun = pathname.match(/^\/agent-link\/v1\/plugins\/([a-z0-9-]+)\/run$/);
    if (pluginRun && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.runLinkedPlugin(req, res, pluginRun[1], body, connection);
      return true;
    }
    if (pathname === '/agent-link/v1/mcp' && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.createLinkedMcp(req, res, body, connection);
      return true;
    }
    if (pathname === '/agent-link/v1/mcp' && method === 'GET') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-filesystem-read');
      const policy = connectorPolicy('read_local', 'high', false, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      json(res, 200, { servers: ctx.mcpCatalog() }); return true;
    }
    const mcpDiscover = pathname.match(/^\/agent-link\/v1\/mcp\/([a-z0-9-]+)\/test$/);
    if (mcpDiscover && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.discoverLinkedMcp(req, res, mcpDiscover[1], body, connection);
      return true;
    }
    const mcpEnable = pathname.match(/^\/agent-link\/v1\/mcp\/([a-z0-9-]+)\/enable$/);
    if (mcpEnable && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.enableLinkedMcp(req, res, mcpEnable[1], body, connection);
      return true;
    }
    const mcpSecrets = pathname.match(/^\/agent-link\/v1\/mcp\/([a-z0-9-]+)\/secrets$/);
    if (mcpSecrets && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.setLinkedMcpCredentials(req, res, mcpSecrets[1], body, connection);
      return true;
    }
    const mcpRemove = pathname.match(/^\/agent-link\/v1\/mcp\/([a-z0-9-]+)\/remove$/);
    if (mcpRemove && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.removeLinkedMcp(req, res, mcpRemove[1], body, connection);
      return true;
    }
    const mcpCall = pathname.match(/^\/agent-link\/v1\/mcp\/([a-z0-9-]+)\/call$/);
    if (mcpCall && method === 'POST') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      await ctx.runLinkedMcp(req, res, mcpCall[1], body, connection);
      return true;
    }
    if (pathname === '/agent-link/v1/avatar/portrait' && ['GET', 'POST'].includes(method)) {
      requireAgentLinkCapability(connection, 'messages');
      const agent = findAgent(connection.agentId);
      if (!agent) { json(res, 404, { error: 'Your agent profile is unavailable.' }); return true; }
      await ctx.portraitAvatarRequest(req, res, agent, body, connection); return true;
    }
    if (pathname === '/agent-link/v1/avatar' && ['GET', 'POST'].includes(method)) {
      requireAgentLinkCapability(connection, 'messages');
      const avatarAgent = findAgent(connection.agentId);
      if (!avatarAgent) { json(res, 404, { error: 'Your agent profile is unavailable.' }); return true; }
      if (method === 'POST') {
        if (state.settings.workMode === 'plan') { json(res, 403, { error: 'Planning mode cannot change avatar presentation.', denied: true }); return true; }
        const policy = connectorPolicy('conversation', 'low', false, { external: true });
        if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
        updateAvatarPresence(avatarAgent, body);
        addReceipt({ agentId: avatarAgent.id, action: 'avatar:update', capability: 'conversation', risk: 'low', status: 'completed', detail: 'The signed agent updated its own local avatar presentation.', source: 'agent-link' });
        await saveState();
      }
      json(res, 200, { avatar: publicAvatarPresence(avatarAgent) }); return true;
    }
    if (pathname === '/agent-link/v1/codex/deliveries' && method === 'GET') {
      requireAgentLinkCapability(connection, 'messages');
      const policy = connectorPolicy('read_local', 'low', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      const deliveries = connection.messages.flatMap(message => {
        const pending = state.codexRelayPending?.find(job => job.id === message.id && job.linkId === connection.id);
        const delivery = message.codexDelivery || (pending ? { state: pending.delivery || 'queued', threadId: pending.threadId, title: pending.threadTitle || pending.threadName || pending.threadId } : null);
        return delivery ? [{ messageId: message.id, clientMessageId: message.clientMessageId, ...delivery }] : [];
      });
      json(res, 200, { deliveries }); return true;
    }
    if (pathname === '/agent-link/v1/capabilities' && method === 'GET') {
      json(res, 200, { connection: publicAgentLink(connection) }); return true;
    }
    if ((pathname === '/agent-link/v1/codex/chats' || pathname === '/agent-link/v1/codex/projects') && method === 'GET') {
      requireAgentLinkCapability(connection, 'messages');
      if (pathname.endsWith('/projects') ? !ctx.codexRelayNamedTargetAllowed?.(connection) : !ctx.codexRelayTargetAllowed?.(connection)) { json(res, 403, { error: 'No Codex conversations are approved for this agent.' }); return true; }
      const policy = connectorPolicy('read_local', 'medium', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      try {
        const operation = pathname.endsWith('/chats') ? 'chats' : 'projects';
        const result = await ctx.codexDirectoryRequest(connection, { operation });
        addReceipt({ agentId: connection.agentId, action: `codex-directory:${operation}`, capability: 'read_local', risk: 'medium', status: 'completed', detail: 'A linked agent read its authorized Codex conversation directory.', source: 'codex-relay' });
        await saveState(); json(res, 200, result);
      } catch { json(res, 503, { error: 'The Codex desktop directory is unavailable.' }); }
      return true;
    }
    if (pathname === '/agent-link/v1/codex/chats' && method === 'POST') {
      requireAgentLinkCapability(connection, 'messages');
      if (!ctx.codexRelayNamedTargetAllowed?.(connection)) { json(res, 403, { error: 'This Link cannot create Codex chats.' }); return true; }
      const policy = connectorPolicy('external_write', 'high', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      if (typeof body?.projectId !== 'string' || !body.projectId || typeof body?.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 10000 || (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 160))) {
        json(res, 400, { error: 'Provide an existing projectId and a prompt of at most 10000 characters.' }); return true;
      }
      try {
        const result = await ctx.codexDirectoryRequest(connection, { operation: 'create-chat', projectId: body.projectId, prompt: body.prompt, title: body.title });
        addReceipt({ agentId: connection.agentId, action: 'codex-directory:create-chat', capability: 'external_write', risk: 'high', status: 'completed', detail: `An owner-trusted Link created Codex chat ${result.threadId} in an existing project.`, source: 'codex-relay' });
        await saveState(); json(res, 201, result);
      } catch { json(res, 503, { error: 'The Codex desktop could not create the chat.' }); }
      return true;
    }
    if (pathname === '/agent-link/v1/capabilities' && method === 'POST') {
      const policy = connectorPolicy('external_write', 'critical', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      const change = toggleOwnerAgentLinkCapabilities(connection, body?.capabilities);
      if (change.removed.includes('desktop-view')) state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, {viewGranted: false, controlGranted: false, textGranted: false, agentControlActive: false});
      else if (change.removed.includes('desktop-control')) state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, {controlGranted: false, textGranted: false, agentControlActive: false});
      else if (change.removed.includes('desktop-type')) state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, {textGranted: false});
      const mediaKinds = { 'camera-view': 'camera', 'microphone-listen': 'microphone', 'speaker-output': 'speaker' };
      const bridge = desktopBridgeSession(state.settings.desktopBridge, connection.id);
      if (bridge?.linkId === connection.id) {
        if (change.removed.includes('desktop-view')) {
          ctx.clearBrowserDesktopFrame?.();
        }
        for (const capability of change.removed) if (mediaKinds[capability]) stopDesktopMediaKind(mediaKinds[capability], 'capability-paused', connection.id);
        if (change.removed.includes('microphone-listen') || change.removed.includes('speaker-output')) {
          endVoiceCall(connection.id, 'capability-paused');
          avatarPresence.hide('capability-paused');
          onRequestPresence.deactivate('capability-paused');
        }
      }
      // Reconcile the complete requested set so a repeated capabilities-set can
      // repair stale hardware grants. This changes session grants only; it never
      // opens a camera/microphone or starts speaker playback.
      const ownerMediaSession = bridge?.enabled === true && bridge.ownerApproved === true && bridge.linkId === connection.id;
      const mediaGrantActivation = {};
      const mediaGrantSpec = [
        ['camera-view', 'camera', 'cameraGranted'],
        ['microphone-listen', 'microphone', 'microphoneGranted'],
        ['speaker-output', 'speaker', 'speakerGranted']
      ];
      for (const [capability, kind, flag] of mediaGrantSpec) {
        if (!connection.capabilities.includes(capability)) {
          mediaGrantActivation[capability] = { status: 'revoked', enabled: false };
          continue;
        }
        if (!ownerMediaSession) {
          mediaGrantActivation[capability] = { status: 'deferred', enabled: false, reason: 'owner-session-inactive' };
          continue;
        }
        if (desktopMediaKindOwnerPaused(connection.id, kind)) {
          mediaGrantActivation[capability] = { status: 'deferred', enabled: false, reason: 'owner-paused' };
          continue;
        }
        let media = publicDesktopMedia(connection.id);
        if (media.linkId && media.linkId !== connection.id) {
          mediaGrantActivation[capability] = { status: 'deferred', enabled: false, reason: 'media-session-mismatch' };
          continue;
        }
        try {
          if (media.linkId !== connection.id || media[flag] !== true) {
            setDesktopMediaKind(connection.id, kind, true, { source: 'agent-policy' });
            media = publicDesktopMedia(connection.id);
          }
          mediaGrantActivation[capability] = media[flag] === true
            ? { status: 'active', enabled: true }
            : { status: 'deferred', enabled: false, reason: 'hardware-grant-not-applied' };
        } catch (error) {
          mediaGrantActivation[capability] = { status: 'deferred', enabled: false, reason: String(error.message || 'hardware-grant-not-applied').slice(0, 160) };
        }
      }
      if (bridge?.enabled === true && bridge.linkId === connection.id) {
        state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, {
          mediaGrants: {
            ...bridge.mediaGrants,
            camera: mediaGrantActivation['camera-view']?.enabled === true,
            microphone: mediaGrantActivation['microphone-listen']?.enabled === true,
            speaker: mediaGrantActivation['speaker-output']?.enabled === true
          }
        });
      }
      queueAgentLinkEvent(connection, { type: 'capabilities', text: 'This Link changed its active capabilities within the owner-approved self-management policy.' });
      const mediaGrantSummary = Object.entries(mediaGrantActivation).map(([capability, result]) => `${capability}=${result.status}${result.reason ? `(${result.reason})` : ''}`).join(', ');
      addReceipt({ agentId: connection.agentId, action: 'agent-link:self-toggle', capability: 'external_write', risk: 'critical',
        status: 'completed', detail: `${connection.identity.name} changed active capabilities on its exact Link within owner-approved self-management. Enabled: ${change.added.join(', ') || 'none'}; paused: ${change.removed.join(', ') || 'none'}. Session media grants: ${mediaGrantSummary || 'none'}.`, source: 'agent-link' });
      await saveState();
      assertAgentLinkCapabilityUpdate(connection, change.capabilities);
      json(res, 200, { connection: publicAgentLink(connection), change, mediaGrantActivation }); return true;
    }
    const currentMemoryContext = async (taskText, metadata = {}) => {
      const unresolvedNamedTarget = typeof metadata?.codexThreadName === 'string' && !metadata?.codexThreadId;
      const scopeFor = (current) => {
        if (unresolvedNamedTarget) return null;
        try {
          return selectMemoryScopeForTurn({
            ...(metadata?.codexThreadId ? { codexThreadId: metadata.codexThreadId } : {}),
            globalMemoryScope: current.memoryScope,
            codexThreadMemoryScopeBindings: current.codexThreadMemoryScopeBindings
          });
        } catch { return null; }
      };
      const selected = scopeFor(connection);
      if (!selected) return { state: 'not-selected' };
      if (!connection.capabilities.includes('memory-read')) return { state: 'not-granted' };
      const agent = findAgent(connection.agentId);
      if (!agent?.continuityLineage?.id || selected.lineageId !== agent.continuityLineage.id) return { state: 'not-selected' };
      const lineageId = agent.continuityLineage.id;
      let scope;
      try {
        scope = normalizeContextScope({ projectId: selected.projectId,
          ...(selected.topicId === undefined ? {} : { topicId: selected.topicId }) });
      } catch { return { state: 'not-selected' }; }
      const scopeKey = (value) => JSON.stringify([value?.projectId || '', value?.topicId || '']);
      const authorizationState = () => {
        const current = state.agentLinks.find((item) => item?.id === connection.id);
        if (current !== connection || current.status !== 'connected' || current.agentId !== agent.id || findAgent(agent.id) !== agent) {
          return { state: 'not-selected' };
        }
        if (!Array.isArray(current.capabilities) || !current.capabilities.includes('memory-read')) return { state: 'not-granted' };
        const deniedNow = connectorPolicy('read_local', 'medium', true, { external: true });
        if (deniedNow) return { state: deniedNow.denied ? 'denied' : 'approval-required' };
        const activeLineage = agent.continuityLineage;
        const activeProfiles = state.agents.filter((candidate) => candidate?.continuityLineage?.id === lineageId &&
          candidate.continuityLineage.activityState === 'active');
        if (activeLineage?.id !== lineageId || activeLineage.activityState !== 'active' || activeLineage.activeAgentId !== agent.id ||
          activeProfiles.length !== 1 || activeProfiles[0] !== agent) {
          return { state: 'not-selected' };
        }
        const currentSelection = scopeFor(current);
        if (!currentSelection || currentSelection.lineageId !== lineageId ||
            currentSelection.projectId !== selected.projectId || (currentSelection.topicId || '') !== (selected.topicId || '')) {
          return { state: 'not-selected' };
        }
        try {
          const currentScope = normalizeContextScope({ projectId: currentSelection.projectId,
            ...(currentSelection.topicId === undefined ? {} : { topicId: currentSelection.topicId }) });
          if (scopeKey(currentScope) !== scopeKey(scope)) return { state: 'not-selected' };
        } catch { return { state: 'not-selected' }; }
        return null;
      };
      const initiallyDenied = authorizationState();
      if (initiallyDenied) return initiallyDenied;
      try {
        const query = Buffer.from(String(taskText ?? '').trim(), 'utf8').subarray(0, 16_000).toString('utf8').trim();
        const retrievalMetrics = state.settings.workMode !== 'plan' && getRetrievalMetrics
          ? await getRetrievalMetrics(agent.id, lineageId).catch(() => null) : null;
        const beforeRead = authorizationState();
        if (beforeRead) return beforeRead;
        const handler = ctx.createMemoryMcpHandler({ store: datedMemoryStore, rag: localMemoryRag,
          lineageId, agentId: agent.id, retrievalMetrics, linkId: connection.id,
          assertActive: async () => ctx.assertAgentActivity(agent) });
        const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'recall-context', arguments: { ...scope, ...(query ? { query } : {}), maxBytes: 2048 }
        } });
        if (response?.error || !response?.result?.structuredContent) return { state: 'unavailable' };
        const afterRead = authorizationState();
        if (afterRead) return afterRead;
        const availableScopes = await datedMemoryStore.listContextScopes({ lineageId });
        const afterScopeCheck = authorizationState();
        if (afterScopeCheck) return afterScopeCheck;
        if (!availableScopes.some((item) => scopeKey(item) === scopeKey(scope))) return { state: 'not-selected' };
        addReceipt({ agentId: agent.id, action: 'memory:automatic-context', capability: 'read_local', risk: 'low',
          status: 'completed', detail: 'A bounded private context packet was prepared for this linked turn while the exact Link grant and selected scope were active. Memory text was excluded from this receipt.', source: 'memory' });
        await saveState();
        const beforeReturn = authorizationState();
        if (beforeReturn) {
          addReceipt({ agentId: agent.id, action: 'memory:automatic-context-delivery', capability: 'read_local', risk: 'low',
            status: 'blocked', detail: 'The prepared private context packet was withheld because this Link authorization changed before delivery. Memory text was excluded from this receipt.', source: 'memory' });
          await saveState().catch(() => {});
          return beforeReturn;
        }
        return { state: 'current', ...response.result.structuredContent };
      } catch { return { state: 'unavailable' }; }
    };
    if (method === 'GET' && pathname === '/agent-link/v1/hexispace/profiles') {
      requireAgentLinkCapability(connection, 'hexispace-profile');
      const profiles = (state.hexispace?.agentProfiles || []).filter((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected' && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_profiles')))
        .map((item) => ({ profileId: item.profileId, connectedAt: item.connectedAt }));
      json(res, 200, { profiles }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/hexispace/profile') {
      requireAgentLinkCapability(connection, 'hexispace-profile');
      const record = state.hexispace?.agentProfiles?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id
        && item.profileId === cleanString(body.profileId)
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected' && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_profiles')));
      if (!record) { json(res, 403, { error: 'This Hexonaut profile is not linked to this agent or its HexiSpace connection was revoked.' }); return true; }
      const denied = connectorPolicy('external_write', 'high', true, { external: true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const result = await updateLinkedHexonautProfile(record, body.profile, credentialVault);
      addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-profile:edit', capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} updated only its linked Hexonaut profile.`, source: 'hexispace' });
      await saveState();
      json(res, 200, { profile: result }); return true;
    }
    if (method === 'POST' && ['/agent-link/v1/hexispace/hexipets', '/agent-link/v1/hexispace/hexipet/equip',
      '/agent-link/v1/hexispace/hexipet/unequip', '/agent-link/v1/hexispace/hexipet/outfit'].includes(pathname)) {
      requireAgentLinkCapability(connection, 'hexispace-profile');
      const record = state.hexispace?.agentProfiles?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id
        && item.profileId === cleanString(body?.profileId)
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected'
          && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_profiles')));
      if (!record) { json(res, 403, { error: 'This Hexonaut profile is not linked to this agent or its HexiSpace connection was revoked.' }); return true; }
      const action = pathname.endsWith('/equip') ? 'equip'
        : pathname.endsWith('/unequip') ? 'unequip' : pathname.endsWith('/outfit') ? 'outfit' : 'list';
      if (action !== 'list') {
        const denied = connectorPolicy('external_write', 'high', true, { external: true });
        if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      }
      const payload = { ...body };
      delete payload.profileId;
      const result = action === 'list'
        ? await listLinkedHexonautHexipets(record, credentialVault, ctx.hexispaceFetch)
        : action === 'equip'
          ? await equipLinkedHexonautHexipet(record, payload, credentialVault, ctx.hexispaceFetch)
          : action === 'unequip'
            ? await unequipLinkedHexonautHexipet(record, payload, credentialVault, ctx.hexispaceFetch)
            : await setLinkedHexonautHexipetOutfit(record, payload, credentialVault, ctx.hexispaceFetch);
      const verbs = { list: 'read its account-owned Hexipet collection', equip: 'equipped one owned Hexipet',
        unequip: 'unequipped its Hexipet', outfit: 'changed its Hexipet outfit' };
      addReceipt({ agentId: connection.agentId, action: `hexispace:agent-hexipet:${action}`,
        capability: action === 'list' ? 'external_read' : 'external_write', risk: action === 'list' ? 'medium' : 'high',
        status: 'completed', detail: `${connection.identity.name} ${verbs[action]}.`, source: 'hexispace' });
      await saveState();
      json(res, 200, action === 'list' ? { collection: result } : { result }); return true;
    }
    if (method === 'POST' && ['/agent-link/v1/hexispace/posts', '/agent-link/v1/hexispace/post'].includes(pathname)) {
      requireAgentLinkCapability(connection, 'hexispace-posts');
      const record = state.hexispace?.agentPosts?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id
        && item.profileId === cleanString(body?.profileId)
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected'
          && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_posts')));
      if (!record) { json(res, 403, { error: 'This Hexonaut cannot post through this agent or its HexiSpace connection was revoked.' }); return true; }
      if (pathname.endsWith('/post')) {
        const denied = connectorPolicy('external_write', 'high', true, { external: true });
        if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
        const post = await publishLinkedHexonautPost(record, body, credentialVault);
        addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-posts:publish', capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} published a text post as its linked Hexonaut.`, source: 'hexispace' });
        await saveState();
        json(res, 200, { post }); return true;
      }
      const posts = await listLinkedHexonautPosts(record, credentialVault);
      json(res, 200, { posts }); return true;
    }
    if (method === 'POST' && ['/agent-link/v1/hexispace/comments', '/agent-link/v1/hexispace/comment'].includes(pathname)) {
      requireAgentLinkCapability(connection, 'hexispace-comments');
      const record = state.hexispace?.agentComments?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id
        && item.profileId === cleanString(body?.profileId)
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected'
          && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_comments')));
      if (!record) { json(res, 403, { error: 'This Hexonaut cannot comment through this agent or its HexiSpace connection was revoked.' }); return true; }
      if (pathname.endsWith('/comment')) {
        const denied = connectorPolicy('external_write', 'high', true, { external: true });
        if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
        const comment = await publishLinkedHexonautComment(record, body, credentialVault);
        addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-comments:publish', capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} commented as its linked Hexonaut on one visible post.`, source: 'hexispace' });
        await saveState();
        json(res, 200, { comment }); return true;
      }
      const comments = await listLinkedHexonautComments(record, body?.postId, credentialVault);
      json(res, 200, { comments }); return true;
    }
    if (method === 'POST' && ['/agent-link/v1/hexispace/friendships', '/agent-link/v1/hexispace/friendship/request', '/agent-link/v1/hexispace/friendship/respond'].includes(pathname)) {
      requireAgentLinkCapability(connection, 'hexispace-friends');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body?.profileId || ''))) {
        json(res, 400, { error: 'Use the exact profileId UUID from hexispace-profiles, not the display name.', code: 'INVALID_PROFILE_ID' }); return true;
      }
      const record = state.hexispace?.agentSocials?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id && item.profileId === cleanString(body?.profileId)
        && item.capabilities.includes('manage_friends')
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected'
          && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_friends')));
      if (!record) { json(res, 403, { error: 'Friendship access is not connected to this Hexonaut and exact HexiGrid Link.' }); return true; }
      if (pathname.endsWith('/request') || pathname.endsWith('/respond')) {
        const denied = connectorPolicy('external_write', 'high', true, { external: true });
        if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      }
      if (pathname.endsWith('/request')) {
        const friendship = await requestLinkedHexonautFriendship(record, body, credentialVault);
        addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-friends:request', capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} requested a friendship as one linked Hexonaut.`, source: 'hexispace' });
        await saveState();
        json(res, 200, { friendship }); return true;
      }
      if (pathname.endsWith('/respond')) {
        const result = await respondLinkedHexonautFriendship(record, body, credentialVault);
        addReceipt({ agentId: connection.agentId, action: `hexispace:agent-friends:${result.decision}`, capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} changed one friendship as a linked Hexonaut.`, source: 'hexispace' });
        await saveState();
        json(res, 200, result); return true;
      }
      const friendships = await listLinkedHexonautFriendships(record, credentialVault);
      addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-friends:list', capability: 'external_read', risk: 'medium', status: 'completed', detail: `${connection.identity.name} listed its own friendship requests and friends.`, source: 'hexispace' });
      await saveState();
      json(res, 200, { friendships }); return true;
    }
    if (method === 'POST' && ['/agent-link/v1/hexispace/relationships', '/agent-link/v1/hexispace/relationship/request', '/agent-link/v1/hexispace/relationship/respond'].includes(pathname)) {
      requireAgentLinkCapability(connection, 'hexispace-relationships');
      const record = state.hexispace?.agentSocials?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id && item.profileId === cleanString(body?.profileId)
        && item.capabilities.includes('manage_relationships')
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected'
          && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_relationships')));
      if (!record) { json(res, 403, { error: 'Linked-profile access is not connected to this Hexonaut and exact HexiGrid Link.' }); return true; }
      if (pathname.endsWith('/request') || pathname.endsWith('/respond')) {
        const denied = connectorPolicy('external_write', 'high', true, { external: true });
        if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      }
      if (pathname.endsWith('/request')) {
        const relationship = await requestLinkedHexonautRelationship(record, body, credentialVault);
        addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-relationships:request', capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} requested a private profile relationship as one linked Hexonaut.`, source: 'hexispace' });
        await saveState();
        json(res, 200, { relationship }); return true;
      }
      if (pathname.endsWith('/respond')) {
        const result = await respondLinkedHexonautRelationship(record, body, credentialVault);
        addReceipt({ agentId: connection.agentId, action: `hexispace:agent-relationships:${result.decision}`, capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} changed one private profile relationship as a linked Hexonaut.`, source: 'hexispace' });
        await saveState();
        json(res, 200, result); return true;
      }
      const relationships = await listLinkedHexonautRelationships(record, credentialVault);
      addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-relationships:list', capability: 'external_read', risk: 'medium', status: 'completed', detail: `${connection.identity.name} listed its own private profile relationships.`, source: 'hexispace' });
      await saveState();
      json(res, 200, { relationships }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/hexispace/reaction') {
      requireAgentLinkCapability(connection, 'hexispace-reactions');
      const record = state.hexispace?.agentSocials?.find((item) => item.agentId === connection.agentId
        && item.agentLinkId === connection.id && item.profileId === cleanString(body?.profileId)
        && item.capabilities.includes('react')
        && state.hexispace.links.some((link) => link.id === item.linkId && link.status === 'connected'
          && Date.parse(link.expiresAt) > Date.now() && link.scopes.includes('agent_reactions')));
      if (!record) { json(res, 403, { error: 'Reaction access is not connected to this Hexonaut and exact HexiGrid Link.' }); return true; }
      const denied = connectorPolicy('external_write', 'high', true, { external: true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const reaction = await setLinkedHexonautReaction(record, body, credentialVault);
      addReceipt({ agentId: connection.agentId, action: 'hexispace:agent-reactions:set', capability: 'external_write', risk: 'high', status: 'completed', detail: `${connection.identity.name} changed one reaction as a linked Hexonaut.`, source: 'hexispace' });
      await saveState();
      json(res, 200, { reaction }); return true;
    }
    if (method === 'GET' && pathname === '/agent-link/v1/desktop/frame') {
      requireAgentLinkCapability(connection, 'desktop-view');
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: connection.id, capability: 'desktop-view', action: 'view' });
      enforceDesktopRateLimit(connection.id, 'frame');
      const frame = await coordinateDesktopRequest({ linkId: connection.id, observe: true, authorize: desktopAuthorityGuard(ctx, connection, bridge) }, () => captureDesktopFrame());
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, { lastFrameAt: frame.capturedAt });
      addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:frame', capability: 'desktop-view', risk: 'medium', status: 'completed', detail: `${connection.identity.name} received one owner-screen frame through the native HexiGrid bridge.`, source: 'desktop-bridge' });
      await saveState();
      json(res, 200, { bridge: publicDesktopBridge(desktopBridgeSession(state.settings.desktopBridge, connection.id), {includeSessions: false}), frame: { mimeType: frame.mimeType, data: frame.data.toString('base64'), capturedAt: frame.capturedAt, source: frame.source || 'native' } }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/input') {
      requireAgentLinkCapability(connection, 'desktop-control');
      if (body.input?.kind === 'text.type') requireAgentLinkCapability(connection, 'desktop-type');
      if (body.input?.kind === 'key.press' && ['Win', 'Meta'].includes(body.input?.key)) ownerAgentAuthorized(connection, state.settings.desktopBridge, 'desktop-system-keys');
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: connection.id, capability: 'desktop-control', action: 'input' });
      if (body.input?.kind === 'text.type') desktopBridgeAuthorized(bridge, { linkId: connection.id, capability: 'desktop-type', action: 'text input' });
      enforceDesktopRateLimit(connection.id, 'input');
      const policy = connectorPolicy('run_tools', 'high', true);
      if (policy) { addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:input:policy', capability: 'run_tools', risk: 'high', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'desktop-bridge' }); json(res, policy.denied ? 403 : 409, policy); return true; }
      let result;
      const checkAuthority = desktopAuthorityGuard(ctx, connection, bridge, { control: true, text: body.input?.kind === 'text.type' });
      try {
        result = await coordinateDesktopRequest({ linkId: connection.id, authorize: () => {
          const current = checkAuthority();
          if (body.input?.kind === 'key.press' && ['Win', 'Meta'].includes(body.input?.key)) ownerAgentAuthorized(connection, state.settings.desktopBridge, 'desktop-system-keys');
          return current;
        } }, authorize => dispatchDesktopInput(body.input, { authorize }));
      } catch (error) {
        if (!error.mayHaveApplied) throw error;
        addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:input', capability: 'desktop-control', risk: 'high', status: 'uncertain', detail: 'Desktop authority changed during input. Inspect the current screen; do not blindly repeat the action.', source: 'desktop-bridge' });
        await saveState(); json(res, error.status || 409, { error: error.message, result: { verified: false, mayHaveApplied: true } }); return true;
      }
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, { lastActionAt: result.actedAt });
      addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:input', capability: 'desktop-control', risk: 'high', status: 'completed', detail: `${connection.identity.name} used one validated computer-control action.`, source: 'desktop-bridge' });
      await saveState();
      json(res, 200, { result, bridge: publicDesktopBridge(desktopBridgeSession(state.settings.desktopBridge, connection.id), {includeSessions: false}) }); return true;
    }
    if (pathname === '/agent-link/v1/model-pool' && method === 'GET') {
      await ctx.modelPoolRequest(req, res, 'status', {}, connection); return true;
    }
    if (pathname === '/agent-link/v1/usage' && method === 'GET') {
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-filesystem-read');
      const denied = connectorPolicy('read_local', 'high', false, { external: true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const query = new URL(req.url || pathname, 'http://localhost').searchParams;
      if (query.size) throw Object.assign(new Error('This read returns all three periods; query parameters are not supported.'), { status: 400 });
      json(res, 200, localUsageSnapshot(state)); return true;
    }
    if (pathname === '/agent-link/v1/usage/budget' && method === 'PUT') {
      const tokenHash = connection.tokenHash;
      const authorize = () => {
        const current = state.agentLinks.find(item => item.id === connection.id);
        if (!current || current.tokenHash !== tokenHash || current.agentId !== connection.agentId) throw Object.assign(new Error('The exact budget-setting Link changed.'), { status: 403 });
        ownerAgentAuthorized(current, state.settings.desktopBridge, 'owner-process');
        const denied = connectorPolicy('write_workspace', 'high', false, { external: true });
        if (denied) throw Object.assign(new Error(denied.error || 'Current policy does not allow budget changes.'), { status: denied.denied ? 403 : 409 });
      };
      authorize();
      if (new URL(req.url || pathname, 'http://localhost').searchParams.size) throw Object.assign(new Error('Budget updates do not accept query parameters.'), { status: 400 });
      const result = await commitUsageBudget(state, body, { requireExpected: true, authorize, saveState, addReceipt, agentId: connection.agentId });
      json(res, 200, result); return true;
    }
    if (pathname === '/agent-link/v1/model-pool/routing' && method === 'POST') {
      await ctx.modelPoolRequest(req, res, 'routing', body, connection); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/uia-inspect') {
      requireAgentLinkCapability(connection, 'desktop-view');
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: connection.id, capability: 'desktop-view', action: 'inspect accessible controls' });
      enforceDesktopRateLimit(connection.id, 'uia-inspect');
      const policy = connectorPolicy('run_tools', 'high', true);
      if (policy) { addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:uia-inspect:policy', capability: 'run_tools', risk: 'high', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'desktop-bridge' }); json(res, policy.denied ? 403 : 409, policy); return true; }
      const result = await coordinateDesktopRequest({ linkId: connection.id, observe: true, authorize: desktopAuthorityGuard(ctx, connection, bridge) }, () => inspectDesktopUia({ linkId: connection.id, bridgeStartedAt: bridge.startedAt }));
      currentDesktopLinkAuthority(ctx, connection);
      addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:uia-inspect', capability: 'desktop-view', risk: 'high', status: result.fallback ? 'blocked' : 'completed', detail: result.fallback ? 'Accessible controls were unavailable; capture a fresh screenshot before using existing coordinate control.' : `${connection.identity.name} inspected bounded accessible controls in the active window.`, source: 'desktop-bridge' });
      await saveState(); json(res, 200, { result }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/uia-act') {
      requireAgentLinkCapability(connection, 'desktop-control');
      if (body.action?.kind === 'set-value') requireAgentLinkCapability(connection, 'desktop-type');
      const bridge = desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: connection.id, capability: 'desktop-control', action: 'UI Automation action' });
      if (body.action?.kind === 'set-value') desktopBridgeAuthorized(bridge, { linkId: connection.id, capability: 'desktop-type', action: 'UI Automation text input' });
      enforceDesktopRateLimit(connection.id, 'uia-act');
      const policy = connectorPolicy('run_tools', 'high', true);
      if (policy) { addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:uia-act:policy', capability: 'run_tools', risk: 'high', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'desktop-bridge' }); json(res, policy.denied ? 403 : 409, policy); return true; }
      let result;
      try {
        result = await coordinateDesktopRequest({ linkId: connection.id, authorize: desktopAuthorityGuard(ctx, connection, bridge, { control: true, text: body.action?.kind === 'set-value' }) }, authorize => actDesktopUia(body.action, { linkId: connection.id, bridgeStartedAt: bridge.startedAt, authorize }));
      } catch (error) {
        if (!error.mayHaveApplied) throw error;
        result = { verified: false, mayHaveApplied: true, fallback: 'screenshot-coordinate' };
      }
      let currentBridge;
      try { currentBridge = currentDesktopLinkAuthority(ctx, connection, { control: true, text: body.action?.kind === 'set-value' }); }
      catch (error) {
        const mayHaveApplied = result.verified || result.mayHaveApplied === true;
        addReceipt({ agentId: connection.agentId, action: `desktop-bridge:uia-act:${body.action?.kind === 'toggle' ? 'toggle' : 'set-value'}`, capability: body.action?.kind === 'set-value' ? 'desktop-type' : 'desktop-control', risk: 'high', status: mayHaveApplied ? 'uncertain' : 'blocked', detail: mayHaveApplied ? 'The action may have applied, but desktop authority changed before its receipt was confirmed. Inspect the active screen before retrying.' : 'Desktop authority changed during the request; no verified action was reported.', source: 'desktop-bridge' });
        await saveState(); json(res, error.status || 409, { error: error.message, result: { ok: true, verified: false, ...(mayHaveApplied ? { mayHaveApplied: true } : {}), fallback: 'screenshot-coordinate' } }); return true;
      }
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, result.actedAt ? { lastActionAt: result.actedAt } : {});
      addReceipt({ agentId: connection.agentId, action: `desktop-bridge:uia-act:${body.action?.kind === 'toggle' ? 'toggle' : 'set-value'}`, capability: body.action?.kind === 'set-value' ? 'desktop-type' : 'desktop-control', risk: 'high', status: result.verified ? 'completed' : result.mayHaveApplied ? 'uncertain' : 'blocked', detail: result.verified ? `${connection.identity.name} used one verified semantic desktop action.` : result.mayHaveApplied ? 'UI Automation may have changed the control but could not verify it; inspect the active screen before retrying.' : `${connection.identity.name} needs a fresh screenshot and existing coordinate-control fallback.`, source: 'desktop-bridge' });
      await saveState(); json(res, 200, { result, bridge: publicDesktopBridge(desktopBridgeSession(state.settings.desktopBridge, connection.id), {includeSessions: false}) }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/start') {
      if (!agentLinkPermissionPolicy(connection).selfManagementEnabled) throw Object.assign(new Error('The owner has not allowed this agent to manage its sharing connection.'), {status: 403});
      if (state.settings.desktopBridge?.recoveryBlocked === true) throw Object.assign(new Error('Emergency Stop is active. The owner must resume sharing first.'), {status: 403});
      if (state.settings.desktopBridge?.ownerControlPaused === true) throw Object.assign(new Error('The owner took control. Only the owner can resume computer sharing.'), {status: 403});
      if (body && Object.keys(body).length) throw Object.assign(new Error('Start uses this Link’s approved permissions; do not supply another agent or permission overrides.'), {status: 400});
      const policy = connectorPolicy('run_tools', 'critical', true, {external: true});
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      const existing = desktopBridgeSession(state.settings.desktopBridge, connection.id);
      if (existing.enabled) {
        const viewGranted = connection.capabilities.includes('desktop-view');
        const controlGranted = viewGranted && connection.capabilities.includes('desktop-control');
        state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, { viewGranted, controlGranted, textGranted: controlGranted && connection.capabilities.includes('desktop-type'), agentControlActive: controlGranted });
        if (publicDesktopMedia(connection.id).linkId !== connection.id) startDesktopMedia({linkId: connection.id,
          cameraGranted: existing.mediaGrants.camera && connection.capabilities.includes('camera-view'),
          microphoneGranted: existing.mediaGrants.microphone && connection.capabilities.includes('microphone-listen'),
          speakerGranted: existing.mediaGrants.speaker && connection.capabilities.includes('speaker-output'),
          ownerPausedMediaKinds: Object.entries(existing.mediaPausedByOwner).filter(([, paused]) => paused).map(([kind]) => kind)});
        await saveState();
        json(res, 200, {bridge: publicDesktopBridge(desktopBridgeSession(state.settings.desktopBridge, connection.id), {includeSessions: false}), media: publicDesktopMedia(connection.id), alreadyActive: true}); return true;
      }
      const active = connection.capabilities;
      const viewGranted = active.includes('desktop-view');
      const controlGranted = viewGranted && active.includes('desktop-control');
      const mediaGrants = {cameraGranted: active.includes('camera-view'), microphoneGranted: active.includes('microphone-listen'), speakerGranted: active.includes('speaker-output')};
      state.settings.desktopBridge = startDesktopBridge(state.settings.desktopBridge, {linkId: connection.id, viewGranted, controlGranted, textGranted: controlGranted && active.includes('desktop-type'), ...mediaGrants});
      startDesktopMedia({linkId: connection.id, ...mediaGrants});
      const bridge = desktopBridgeSession(state.settings.desktopBridge, connection.id);
      queueAgentLinkEvent(connection, {type: 'desktop.session.started', text: 'Your approved sharing connection is ready. Browser microphone and playback still require their normal owner interaction.'});
      const receipt = addReceipt({agentId: connection.agentId, action: 'desktop-bridge:agent-start', capability: 'run_tools', risk: 'critical', status: 'completed', detail: `${connection.identity.name} restarted only its own sharing connection within existing owner-approved permissions.`, source: 'desktop-bridge'});
      await saveState(); json(res, 200, {bridge: publicDesktopBridge(bridge, {includeSessions: false}), media: publicDesktopMedia(connection.id), receipt}); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/stop') {
      if (!['desktop-view', 'camera-view', 'microphone-listen', 'speaker-output'].some(scope => connection.capabilities.includes(scope))) throw Object.assign(new Error('This Link has no computer or media permission.'), {status: 403});
      desktopBridgeAuthorized(state.settings.desktopBridge, { linkId: connection.id, capability: 'conversation', action: 'stop' });
      endVoiceCall(connection.id, 'agent-stop');
      state.settings.desktopBridge = stopDesktopBridge(state.settings.desktopBridge, 'agent-stop', connection.id);
      stopDesktopMedia('agent-stop', connection.id);
      avatarPresence?.hide('agent-stop');
      onRequestPresence?.deactivate('agent-stop');
      addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:agent-stop', capability: 'emergency_stop', risk: 'critical', status: 'completed', detail: `${connection.identity.name} stopped its own native computer access.`, source: 'desktop-bridge' });
      addActivity('security', `${connection.identity.name} stopped its own computer access.`);
      await saveState(); json(res, 200, { bridge: publicDesktopBridge(desktopBridgeSession(state.settings.desktopBridge, connection.id), {includeSessions: false}) }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/workspace/list') {
      requireAgentLinkCapability(connection, 'workspace-read');
      const policy = connectorPolicy('read_local', 'medium', true, { external: true });
      if (policy) { addReceipt({ agentId: connection.agentId, action: 'workspace:list:policy', capability: 'read_local', risk: 'medium', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'agent-link-workspace' }); json(res, policy.denied ? 403 : 409, policy); return true; }
      const result = await listAgentLinkWorkspace(agentLinkWorkspaceRoot || projectRoot, body.path ?? '.');
      addReceipt({ agentId: connection.agentId, action: 'workspace:list', capability: 'read_local', risk: 'medium', status: 'completed', detail: `${connection.identity.name} listed ${result.path || 'the owner-approved project root'} through the scoped HexiGrid project door.`, source: 'agent-link-workspace' });
      await saveState(); json(res, 200, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/workspace/read') {
      requireAgentLinkCapability(connection, 'workspace-read');
      const policy = connectorPolicy('read_local', 'medium', true, { external: true });
      if (policy) { addReceipt({ agentId: connection.agentId, action: 'workspace:read:policy', capability: 'read_local', risk: 'medium', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'agent-link-workspace' }); json(res, policy.denied ? 403 : 409, policy); return true; }
      const result = await readAgentLinkWorkspaceFile(agentLinkWorkspaceRoot || projectRoot, body.path);
      addReceipt({ agentId: connection.agentId, action: 'workspace:read', capability: 'read_local', risk: 'medium', status: 'completed', detail: `${connection.identity.name} read project file ${result.path} (${result.size} bytes). File contents are not recorded.`, source: 'agent-link-workspace' });
      await saveState(); json(res, 200, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/workspace/write') {
      requireAgentLinkCapability(connection, 'workspace-write');
      const policy = connectorPolicy('write_workspace', 'high', true, { external: true });
      if (policy) { addReceipt({ agentId: connection.agentId, action: 'workspace:write:policy', capability: 'write_workspace', risk: 'high', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'agent-link-workspace' }); json(res, policy.denied ? 403 : 409, policy); return true; }
      const result = await writeAgentLinkWorkspaceFile(agentLinkWorkspaceRoot || projectRoot, body);
      addReceipt({ agentId: connection.agentId, action: 'workspace:write', capability: 'write_workspace', risk: 'high', status: 'completed', detail: `${connection.identity.name} ${result.created ? 'created' : 'updated'} project file ${result.path} (${result.size} bytes). File contents are not recorded.`, source: 'agent-link-workspace' });
      await saveState(); json(res, 200, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/tasks') {
      requireAgentLinkCapability(connection, 'tasks');
      await handleLinkedTasks(req, res, ctx, connection, body);
      return true;
    }
    if (method === 'POST' && pathname.startsWith('/agent-link/v1/owner/')) {
      const operation = pathname.slice('/agent-link/v1/owner/'.length);
      const capability = operation === 'fs/list' || operation === 'fs/read' ? 'owner-filesystem-read'
        : operation === 'fs/write' ? 'owner-filesystem-write'
        : operation === 'exec' ? 'owner-process' : '';
      if (!capability) { json(res, 404, { error: 'Owner-agent operation not found.' }); return true; }
      ownerAgentAuthorized(connection, state.settings.desktopBridge, capability);
      const policyCapability = operation === 'fs/list' || operation === 'fs/read' ? 'read_local'
        : operation === 'fs/write' ? 'write_workspace' : 'run_tools';
      const risk = operation === 'fs/list' || operation === 'fs/read' ? 'high' : 'critical';
      const policy = connectorPolicy(policyCapability, risk, false, { external: true });
      if (policy) {
        addReceipt({ agentId: connection.agentId, action: `owner-agent:${operation}:policy`, capability: policyCapability, risk, status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'owner-agent' });
        json(res, policy.denied ? 403 : 409, policy); return true;
      }
      const result = operation === 'fs/list' ? await listOwnerAgentDirectory(body.path)
        : operation === 'fs/read' ? await readOwnerAgentFile(body.path, body)
        : operation === 'fs/write' ? await writeOwnerAgentFile(body)
        : await runOwnerAgentProcess(body);
      addReceipt({ agentId: connection.agentId, action: `owner-agent:${operation}`, capability: policyCapability, risk, status: 'completed', detail: operation === 'exec' ? `${connection.identity.name} ran one owner-granted local process; command and output are not logged.` : `${connection.identity.name} used owner-granted machine file ${operation}; file contents are not logged.`, source: 'owner-agent' });
      await saveState(); json(res, 200, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/speaker') {
      requireAgentLinkCapability(connection, 'speaker-output');
      const bridge = callMediaBridge(state, connection.id);
      const voiceCall = publicVoiceCall();
      if (voiceCall.linkId === connection.id && ['offered', 'ringing', 'active'].includes(voiceCall.status) && voiceCall.ownerMuted) {
        json(res, 202, { muted: true, media: publicDesktopMedia(connection.id) }); return true;
      }
      enforceDesktopRateLimit(connection.id, 'speaker');
      const result = publishSpeakerChunk(bridge.linkId, body);
      addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:speaker', capability: 'speaker-output', risk: 'medium', status: 'completed', detail: `${connection.identity.name} sent one bounded audio segment to the owner's speakers.`, source: 'desktop-bridge' });
      json(res, 202, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/voice-call/reply') {
      requireAgentLinkCapability(connection, 'speaker-output');
      if (body.callId && requireVoiceCall(connection.id, ['active']).id !== body.callId) throw Object.assign(new Error('This reply belongs to a different or ended call.'), { status: 409 });
      const replyEpoch = requireVoiceCall(connection.id, ['active']).mediaEpoch;
      if ((replyEpoch > 0 && body.mediaEpoch === undefined) || (body.mediaEpoch !== undefined && (!Number.isSafeInteger(body.mediaEpoch) || body.mediaEpoch !== replyEpoch))) throw Object.assign(new Error('The call selection changed. Read the active call and include its mediaEpoch before replying.'), { status: 409 });
      callMediaBridge(state, connection.id);
      enforceDesktopRateLimit(connection.id, 'speaker');
      const result = body.audio
        ? publishVoiceReplyAudio(connection.id, body.text, body.audio)
        : publishVoiceReplyText(connection.id, body.text);
      ctx.onVoiceReply?.({ connection, call: publicVoiceCall(), text: body.text });
      onRequestPresence?.activity(connection.id);
      if (avatarPresence?.status().visible) avatarPresence.setStateFor('speaking', publicVoiceCall().status === 'active' ? 'listening' : 'idle', Math.max(900, Math.min(12000, String(body.text || '').length * 55)));
      addReceipt({ agentId: connection.agentId, action: 'voice-call:reply', capability: 'speaker-output', risk: 'medium', status: 'completed', detail: body.audio ? `${connection.identity.name} sent a bounded provider-generated audio reply to the owner device.` : `${connection.identity.name} sent a bounded text reply for the owner device to speak with the configured agent voice.`, source: 'voice-call' });
      json(res, 202, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/voice-call/media') {
      requireAgentLinkCapability(connection, 'microphone-listen');
      requireAgentLinkCapability(connection, 'speaker-output');
      const callId = String(body.callId || '');
      const afterAudioSequence = Number(body.afterAudioSequence ?? 0);
      const waitMs = Number(body.waitMs ?? 8000);
      if (!callId || callId.length > 160 || !Number.isSafeInteger(afterAudioSequence) || afterAudioSequence < 0 ||
          !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10_000) {
        json(res, 400, { error: 'Supply the exact callId, a nonnegative audio cursor, and waitMs from 0 to 10000.' }); return true;
      }
      const tokenHash = connection.tokenHash;
      const authorize = () => {
        const current = state.agentLinks.find(item => item.id === connection.id && item.tokenHash === tokenHash &&
          item.agentId === connection.agentId && item.status === 'connected');
        if (!current) throw Object.assign(new Error('The exact connected Link credential is no longer active.'), { status: 403 });
        requireAgentLinkCapability(current, 'microphone-listen');
        requireAgentLinkCapability(current, 'speaker-output');
        const bridge = callMediaBridge(state, current.id);
        if (!bridge.ownerApproved) throw Object.assign(new Error('Voice media requires the existing owner-approved computer session.'), { status: 403 });
        const active = requireVoiceCall(current.id, ['active']);
        if (active.id !== callId || active.ownerMuted) throw Object.assign(new Error('This exact voice call is muted, ended, or no longer active.'), { status: 409 });
        const policy = connectorPolicy('conversation', 'high', true, { external: true });
        if (policy) throw Object.assign(new Error(policy.error || 'Current policy blocks voice media.'), { status: policy.denied ? 403 : 409 });
        return active;
      };
      const initialMediaEpoch = authorize().mediaEpoch;
      const effectiveAfterAudioSequence = afterAudioSequence === 0
        ? Math.max(0, Number(voiceCallMicrophoneSequenceStart(connection.id) || 1) - 1)
        : afterAudioSequence;
      enforceDesktopRateLimit(connection.id, 'voice-media');
      const abort = new AbortController();
      req.once('aborted', () => abort.abort());
      let mediaResult;
      try {
        mediaResult = waitMs > 0
          ? await waitForDesktopMicrophone(connection.id, effectiveAfterAudioSequence, { waitMs, signal: abort.signal })
          : readDesktopMicrophone(connection.id, effectiveAfterAudioSequence);
      } catch (error) {
        if (abort.signal.aborted) return true;
        throw error;
      }
      const voiceCall = authorize();
      if (voiceCall.mediaEpoch !== initialMediaEpoch) throw Object.assign(new Error('The call selection changed during this media request. Read the active call again.'), { status: 409 });
      json(res, 200, { voiceCall, media: mediaResult.media, audio: mediaResult.audio, replay: { audio: mediaResult.replay } }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/desktop/media') {
      callMediaBridge(state, connection.id);
      if (connection.capabilities.includes('camera-view')) {
        const tokenHash = connection.tokenHash;
        const authorize = () => {
          const current = state.agentLinks.find(item => item.id === connection.id && item.tokenHash === tokenHash && item.status === 'connected');
          requireAgentLinkCapability(current || { capabilities: [] }, 'camera-view');
          const bridge = callMediaBridge(state, connection.id);
          if (!bridge.ownerApproved) throw Object.assign(new Error('Camera capture requires an owner-approved computer session.'), { status: 403 });
          const policy = connectorPolicy('read_local', 'high', true, { external: true });
          if (policy) throw Object.assign(new Error(policy.error || 'Current policy blocks camera capture.'), { status: policy.denied ? 403 : 409 });
        };
        if (body.freshCamera !== undefined && typeof body.freshCamera !== 'boolean') throw Object.assign(new Error('freshCamera must be true or false.'), { status: 400 });
        await ensureAgentCamera(connection.id, authorize, { afterCameraSequence: body.afterCameraSequence, fresh: body.freshCamera === true });
        addReceipt({ agentId: connection.agentId, action: 'desktop-bridge:camera-read', capability: 'camera-view', risk: 'high', status: 'completed', detail: 'The authorized Link received a bounded camera frame. Frame contents are not recorded.', source: 'desktop-bridge' });
      }
      const voice = publicVoiceCall();
      const scopes = voice.linkId === connection.id && voice.status === 'ringing' ? connection.capabilities.filter(cap => !['microphone-listen', 'speaker-output'].includes(cap)) : connection.capabilities;
      json(res, 200, { ...readDesktopMedia(connection.id, scopes, body.afterAudioSequence, body.afterSpeakerSequence, body.afterCameraSequence), freshCamera: body.freshCamera === true && connection.capabilities.includes('camera-view') }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/voice-call/initiate') {
      const bridge = callMediaBridge(state, connection.id);
      if (!bridge.ownerApproved) throw Object.assign(new Error('Calls require an owner-approved computer session.'), { status: 403 });
      const policy = connectorPolicy('conversation', 'high', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      const requiredAudio = ['microphone-listen', 'speaker-output'];
      const missingAudio = requiredAudio.filter((capability) => !connection.capabilities.includes(capability));
      const ownerApprovedAudio = new Set(connection.ownerGrantedCapabilities || []);
      if (missingAudio.some((capability) => !ownerApprovedAudio.has(capability))) {
        throw Object.assign(new Error('The owner needs to allow audio calling for this Link.'), { status: 403 });
      }
      if (publicDesktopMedia(connection.id).linkId !== connection.id) {
        startDesktopMedia({
          linkId: connection.id,
          cameraGranted: bridge.mediaGrants?.camera === true,
          microphoneGranted: bridge.mediaGrants?.microphone === true,
          speakerGranted: bridge.mediaGrants?.speaker === true,
          ownerPausedMediaKinds: Object.entries(bridge.mediaPausedByOwner || {}).filter(([, paused]) => paused).map(([kind]) => kind)
        });
      }
      // Let the call service validate active-call and rate-limit rules before
      // preparing any device authorization.
      let voiceCall = initiateVoiceCall({ linkId: connection.id, callerName: connection.identity.name, microphoneGranted: true, speakerGranted: true });
      if (missingAudio.length) {
        try {
          const change = toggleOwnerAgentLinkCapabilities(connection, [...connection.capabilities, ...missingAudio]);
          assertAgentLinkCapabilityUpdate(connection, change.capabilities);
        } catch (error) {
          endVoiceCall(connection.id, 'audio-policy-restore-failed');
          throw error;
        }
      }
      for (const capability of requiredAudio) requireAgentLinkCapability(connection, capability);
      // A call is one product action: prepare the already-approved device
      // grants here so the agent never has to reconcile hardware separately.
      // An explicit owner pause is respected until Allow on the incoming call.
      const initialMedia = publicDesktopMedia(connection.id);
      const mediaSetup = {
        ...bridge.mediaGrants,
        microphone: bridge.mediaGrants?.microphone === true || (initialMedia.linkId === connection.id && initialMedia.microphoneGranted === true),
        speaker: bridge.mediaGrants?.speaker === true || (initialMedia.linkId === connection.id && initialMedia.speakerGranted === true)
      };
      try {
        for (const kind of ['microphone', 'speaker']) {
          const ownerPaused = bridge.mediaPausedByOwner?.[kind] === true || desktopMediaKindOwnerPaused(connection.id, kind);
          if (ownerPaused) continue;
          const flag = kind === 'microphone' ? 'microphoneGranted' : 'speakerGranted';
          if (publicDesktopMedia(connection.id)[flag] !== true) setDesktopMediaKind(connection.id, kind, true, { source: 'agent-policy' });
          mediaSetup[kind] = publicDesktopMedia(connection.id)[flag] === true;
          if (!mediaSetup[kind]) throw Object.assign(new Error(`Your call could not connect to the ${kind === 'microphone' ? 'microphone' : 'speaker'} already allowed for this Link.`), { status: 409 });
        }
      } catch (error) {
        endVoiceCall(connection.id, 'media-setup-failed');
        throw error;
      }
      state.settings.desktopBridge = updateDesktopBridgeSession(state.settings.desktopBridge, connection.id, { mediaGrants: { ...bridge.mediaGrants, ...mediaSetup } });
      pauseDesktopAudio(connection.id, 'incoming-call-ringing');
      voiceCall = setVoiceCallMicrophoneSequenceStart(connection.id, nextDesktopMicrophoneSequence(connection.id));
      queueAgentLinkEvent(connection, { type: 'voice.call.ringing', text: 'Your call is ringing on the owner device. Wait for acceptance.', metadata: { callId: voiceCall.id, mediaEpoch: voiceCall.mediaEpoch, expiresAt: voiceCall.expiresAt } });
      addReceipt({ agentId: connection.agentId, action: 'voice-call:initiate', capability: 'conversation', risk: 'high', status: 'completed', detail: 'The paired agent offered an incoming call. Audio waits for owner acceptance.', source: 'voice-call' });
      await saveState();
      try { ctx.notifyIncomingVoiceCall?.(voiceCall); } catch { /* The browser call prompt remains available if Windows notifications are unavailable. */ }
      json(res, 201, { voiceCall, callHandling: agentLinkOrientation(connection, state.settings).callHandling }); return true;
    }
    if (method === 'GET' && pathname === '/agent-link/v1/voice-call') {
      requireAgentLinkCapability(connection, 'microphone-listen');
      requireAgentLinkCapability(connection, 'speaker-output');
      const voiceCall = publicVoiceCall(connection.id);
      json(res, 200, { voiceCall }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/voice-call/answer') {
      requireAgentLinkCapability(connection, 'microphone-listen');
      requireAgentLinkCapability(connection, 'speaker-output');
      if (!publicVoiceCall(connection.id).onHold) callMediaBridge(state, connection.id);
      const voiceCall = answerVoiceCall(connection.id);
      if (!voiceCall.onHold && avatarPresence?.status().visible) avatarPresence.setState('listening');
      addReceipt({ agentId: connection.agentId, action: 'voice-call:answer', capability: 'conversation', risk: 'medium', status: 'completed', detail: `${connection.identity.name} answered the session-only voice call.`, source: 'voice-call' });
      await saveState(); json(res, 200, { voiceCall, callHandling: agentLinkOrientation(connection, state.settings).callHandling }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/voice-call/end') {
      const endingCall = publicVoiceCall(connection.id);
      if (!endingCall.onHold) requireVoiceCall(connection.id);
      const requestedPresence = onRequestPresence?.status().active && onRequestPresence.status().linkId === connection.id;
      const voiceCall = endVoiceCall(connection.id, 'agent-ended');
      if (!endingCall.onHold) {
        if (requestedPresence) pauseDesktopAudio(connection.id, 'agent-ended-voice-call');
        else pauseDesktopMediaKind('all', 'agent-ended-voice-call');
        avatarPresence?.hide('agent-ended-voice-call');
        onRequestPresence?.deactivate('agent-ended-voice-call');
        const original = state.settings.desktopBridge;
        if (original?.enabled && publicDesktopMedia(connection.id).linkId !== original.linkId) {
          startDesktopMedia({ linkId: original.linkId, cameraGranted: original.mediaGrants.camera, microphoneGranted: original.mediaGrants.microphone, speakerGranted: original.mediaGrants.speaker, preserveSequences: true });
          pauseDesktopMediaKind('all', 'agent-ended-voice-call');
        }
      }
      addReceipt({ agentId: connection.agentId, action: 'voice-call:agent-end', capability: 'emergency_stop', risk: 'high', status: 'completed', detail: `${connection.identity.name} ended the call and stopped active camera plus both audio streams. Approved media access remains available for the next call.`, source: 'voice-call' });
      addActivity('security', `${connection.identity.name} ended its voice call.`);
      await saveState(); json(res, 200, { voiceCall, media: publicDesktopMedia(connection.id) }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/voice-call/probe') {
      requireAgentLinkCapability(connection, 'microphone-listen');
      requireAgentLinkCapability(connection, 'speaker-output');
      const data = String(body.data || '');
      if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 88 * 1024) throw Object.assign(new Error('Synthetic latency probe audio is invalid or too large.'), { status: 400 });
      const voiceCall = requireVoiceCall(connection.id);
      json(res, 200, { voiceCall: { ...voiceCall }, probe: { id: String(body.id || '').slice(0, 120), mimeType: 'audio/wav', data, synthetic: true, serverReceivedAt: new Date().toISOString() } }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/heartbeat') {
      const heartbeat = recordAgentLinkHeartbeat(connection, body || {});
      await saveState();
      json(res, 200, { ok: true, heartbeat, connection: publicAgentLink(connection) }); return true;
    }
    if (method === 'GET' && pathname === '/agent-link/v1/events') { json(res, 200, { connection: publicAgentLink(connection), ...readAgentLinkEventPage(connection, new URL(req.url, 'http://localhost').searchParams.get('after')) }); return true; }
    if (method === 'POST' && pathname === '/agent-link/v1/events/poll') {
      const abort = new AbortController();
      req.once('aborted', () => abort.abort());
      const result = await waitForAgentLinkEvents(connection, { after: body.after, waitMs: body.waitMs, signal: abort.signal });
      json(res, 200, { connection: publicAgentLink(connection), ...result }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/ack') { const acknowledged = acknowledgeAgentLinkEvents(connection, body.through); await saveState(); json(res, 200, { ok: true, acknowledged }); return true; }
    if ((method === 'GET' && pathname === '/agent-link/v1/messages') || (method === 'POST' && pathname === '/agent-link/v1/messages/history')) {
      requireAgentLinkCapability(connection, 'messages');
      const policy = connectorPolicy('read_local', 'medium', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      const agent = findAgent(connection.agentId);
      if (!agent) { json(res, 404, { error: 'The linked agent profile is missing.' }); return true; }
      await ctx.assertAgentActivity(agent);
      json(res, 200, method === 'POST'
        ? readAgentLinkConversationPage(connection, { before: body?.before, limit: body?.limit === undefined ? 100 : body.limit })
        : { messages: readAgentLinkConversation(connection), limit: 100 }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/memory-scope') {
      requireAgentLinkCapability(connection, 'memory-read');
      const denied = connectorPolicy('write_workspace', 'low', true, { external: true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const agent = findAgent(connection.agentId);
      if (!agent?.continuityLineage?.id) { json(res, 404, { error: 'The linked agent has no active memory lineage.' }); return true; }
      await ctx.assertAgentActivity(agent);
      const threadIdProvided = Object.hasOwn(body, 'codexThreadId');
      const codexThreadId = threadIdProvided ? body.codexThreadId : undefined;
      if (threadIdProvided && (typeof codexThreadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/.test(codexThreadId))) {
        json(res, 400, { error: 'Provide a valid Codex conversation ID for a thread-specific memory scope.' }); return true;
      }
      if (body.scope === null) {
        if (threadIdProvided) {
          try { connection.codexThreadMemoryScopeBindings = setCodexThreadMemoryScopeBinding(
            connection.codexThreadMemoryScopeBindings, codexThreadId, null); }
          catch (error) { json(res, 400, { error: error.message }); return true; }
        } else connection.memoryScope = null;
      }
      else {
        const selected = normalizeContextScope(body.scope);
        const available = await datedMemoryStore.listContextScopes({ lineageId: agent.continuityLineage.id });
        if (!available.some((scope) => scope.projectId === selected.projectId && (scope.topicId || '') === (selected.topicId || ''))) {
          json(res, 404, { error: 'That current memory scope is unavailable for this agent.' }); return true;
        }
        const memoryScope = { lineageId: agent.continuityLineage.id, ...selected };
        if (threadIdProvided) {
          try { connection.codexThreadMemoryScopeBindings = setCodexThreadMemoryScopeBinding(
            connection.codexThreadMemoryScopeBindings, codexThreadId, memoryScope); }
          catch (error) { json(res, 400, { error: error.message }); return true; }
        } else connection.memoryScope = memoryScope;
      }
      addReceipt({ agentId: agent.id, action: 'memory:select-context', capability: 'write_workspace', risk: 'low',
        status: 'completed', detail: 'The linked agent changed its private memory context selection. No fact text was included.', source: 'memory' });
      await saveState();
      const memoryScope = threadIdProvided
        ? connection.codexThreadMemoryScopeBindings.find((item) => item.codexThreadId === codexThreadId)?.memoryScope || null
        : connection.memoryScope;
      json(res, 200, { memoryScope, ...(threadIdProvided ? { codexThreadId } : {}) }); return true;
    }
    const eraseMemory = pathname.match(/^\/agent-link\/v1\/memory\/(memory-[a-f0-9-]{36})$/i);
    if (method === 'DELETE' && eraseMemory) {
      const memoryId = eraseMemory[1].toLowerCase();
      ownerAgentAuthorized(connection, state.settings.desktopBridge, 'owner-process');
      requireAgentLinkCapability(connection, 'memory-write');
      const agent = findAgent(connection.agentId);
      if (!agent?.continuityLineage?.id) { json(res, 404, { error: 'Memory record not found.' }); return true; }
      const lineageId = agent.continuityLineage.id;
      const tokenHash = connection.tokenHash;
      const assertAuthorized = () => {
        const current = state.agentLinks.find(item => item.id === connection.id);
        if (!current || current.tokenHash !== tokenHash || current.agentId !== agent.id || findAgent(agent.id) !== agent || agent.continuityLineage?.id !== lineageId) {
          throw Object.assign(new Error('The exact Link memory-erasure authority changed.'), { status: 403 });
        }
        ownerAgentAuthorized(current, state.settings.desktopBridge, 'owner-process');
        requireAgentLinkCapability(current, 'memory-write');
        ctx.assertAgentActivity(agent);
        const denied = connectorPolicy('write_workspace', 'high', true, { external: true });
        if (denied) throw Object.assign(new Error('Current policy does not allow permanent memory erasure.'), { status: denied.denied ? 403 : 409 });
      };
      assertAuthorized();
      const principal = connection.agentId;
      const existingMemory = await datedMemoryStore.getById({ lineageId, id: memoryId, depth: 0 });
      if (existingMemory) {
        const allowed = consumeMemoryWriteBudget(state, { source: { kind: 'agent-link', callerId: connection.id,
          linkId: connection.id, agentId: agent.id, lineageId }, bytes: Buffer.byteLength(memoryId, 'utf8'), at: Date.parse(now()) });
        if (!allowed) {
          await saveState();
          json(res, 429, { error: 'This agent has reached its short-term memory change limit. Retry after recent changes expire.',
            code: 'MEMORY_WRITE_RATE_LIMIT' }); return true;
        }
        // Save the budget first so a process interruption cannot make a
        // committed erasure disappear from the rolling write count.
        await saveState();
        assertAuthorized();
      }
      const deleted = await datedMemoryStore.hardDelete({ lineageId, id: memoryId, assertAuthorized });
      if (!deleted) assertAuthorized();
      try {
        if (typeof localMemoryRag?.hardDelete !== 'function') throw new Error('Derived index cleanup unavailable.');
        await localMemoryRag.hardDelete({ lineageId, id: memoryId });
      }
      catch { json(res, 503, { error: 'Canonical memory is absent, but derived index cleanup is incomplete. Retry this exact deletion to finish cleanup.', code: 'memory_erasure_cleanup_pending' }); return true; }
      if (!deleted) { json(res, 404, { error: 'Memory record not found; any stale derived index entry was cleared.' }); return true; }
      addReceipt({ agentId: agent.id, action: 'memory:permanent-erasure', capability: 'owner-process', risk: 'high', status: 'completed',
        detail: `Memory ${memoryId} permanently erased at ${now()} by ${principal}. Content was excluded.`, source: 'memory' });
      await saveState();
      json(res, 200, { erased: true, id: memoryId }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/shared-memory') {
      requireAgentLinkCapability(connection, 'memory-read');
      const denied = connectorPolicy('read_local', 'medium', true, { external: true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const target = findAgent(connection.agentId);
      if (!target?.continuityLineage?.id) { json(res, 404, { error: 'The linked agent has no active memory lineage.' }); return true; }
      const targetReadGuard = signedMemoryMistakeReadGuard(ctx, connection, target, target.continuityLineage.id);
      targetReadGuard();
      await ctx.assertAgentActivity(target);
      targetReadGuard();
      const visible = (state.memoryShares || []).filter((share) => share.status === 'active' &&
        share.targetAgentId === target.id && share.targetLineageId === target.continuityLineage.id &&
        share.targetLinkId === connection.id &&
        state.agents.some((source) => source.id === share.sourceAgentId &&
          source.continuityLineage?.id === share.sourceLineageId && source.continuityLineage.activityState === 'active'));
      if (body.operation === 'list') {
        const limit = body.limit === undefined ? 10 : body.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) { json(res, 400, { error: 'Shared memory page size must be from 1 to 10.' }); return true; }
        visible.sort((left, right) => left.grantedAt.localeCompare(right.grantedAt) || left.id.localeCompare(right.id));
        const start = body.after === undefined ? 0 : visible.findIndex((share) => share.id === body.after) + 1;
        if (body.after !== undefined && start === 0) { json(res, 409, { error: 'The shared memory cursor is no longer available.' }); return true; }
        const page = visible.slice(start, start + limit);
        json(res, 200, { shares: page.map((share) => ({ id: share.id, sourceAgentId: share.sourceAgentId,
          sourceName: findAgent(share.sourceAgentId)?.name || '', scope: share.scope, grantedAt: share.grantedAt })),
          hasMore: start + limit < visible.length, nextCursor: start + limit < visible.length ? page.at(-1).id : null }); return true;
      }
      if (body.operation === 'recall') {
        const share = findActiveMemoryShare(visible, { id: body.shareId, targetAgentId: target.id,
          targetLineageId: target.continuityLineage.id, targetLinkId: connection.id });
        if (!share) { json(res, 404, { error: 'This exact Link has no active grant for that memory scope.' }); return true; }
        const source = findAgent(share.sourceAgentId);
        if (!source || source.continuityLineage?.id !== share.sourceLineageId || source.continuityLineage.activityState !== 'active') {
          json(res, 404, { error: 'The source memory lineage is no longer active.' }); return true;
        }
        const pinnedShare = JSON.stringify({ id: share.id, sourceAgentId: share.sourceAgentId, sourceLineageId: share.sourceLineageId,
          targetAgentId: share.targetAgentId, targetLineageId: share.targetLineageId, targetLinkId: share.targetLinkId, scope: share.scope });
        const sharedReadGuard = () => {
          targetReadGuard();
          const current = findActiveMemoryShare(state.memoryShares, { id: share.id, targetAgentId: target.id,
            targetLineageId: target.continuityLineage.id, targetLinkId: connection.id });
          const sourceLineage = source.continuityLineage;
          const active = state.agents.filter(item => item.continuityLineage?.id === share.sourceLineageId && item.continuityLineage.activityState === 'active');
          const identity = current && JSON.stringify({ id: current.id, sourceAgentId: current.sourceAgentId, sourceLineageId: current.sourceLineageId,
            targetAgentId: current.targetAgentId, targetLineageId: current.targetLineageId, targetLinkId: current.targetLinkId, scope: current.scope });
          if (identity !== pinnedShare || findAgent(source.id) !== source || sourceLineage?.id !== share.sourceLineageId ||
            sourceLineage.activityState !== 'active' || sourceLineage.activeAgentId !== source.id || active.length !== 1 || active[0] !== source) {
            throw Object.assign(new Error('The exact shared memory authority is no longer active.'), { status: 403 });
          }
        };
        sharedReadGuard();
        const handler = ctx.createMemoryMcpHandler({ store: datedMemoryStore, rag: localMemoryRag,
          lineageId: share.sourceLineageId, agentId: source.id, assertActive: sharedReadGuard });
        const result = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'recall-context', arguments: { ...share.scope, maxBytes: body.maxBytes ?? 8192,
            ...(body.cursor === undefined ? {} : { cursor: body.cursor }) }
        } });
        sharedReadGuard();
        if (result?.error) { json(res, 400, { error: result.error.message }); return true; }
        const entries = await datedMemoryStore.listMemoryMistakes({ lineageId: share.sourceLineageId,
          agentId: source.id, contextScope: share.scope, limit: 50, depth: 2 });
        sharedReadGuard();
        const records = entries.map(entry => canonicalRecordFromDatedEntry(entry,
          { lineageId: share.sourceLineageId, agentId: source.id, scope: share.scope })).filter(Boolean);
        const mistakeWarnings = buildSharedMemoryMistakeWarnings({ records, shares: state.memoryShares,
          shareId: share.id, sourceAgentId: source.id, sourceLineageId: share.sourceLineageId, sourceLineageActive: true,
          targetAgentId: target.id, targetLineageId: share.targetLineageId, targetLineageActive: true, targetLinkId: connection.id });
        addReceipt({ agentId: target.id, action: 'memory:shared-context-read', capability: 'read_local', risk: 'medium',
          status: 'completed', detail: `${target.name} read one owner-shared scope from ${source.name}. Fact text was excluded.`, source: 'memory' });
        await saveState();
        sharedReadGuard();
        json(res, 200, { shareId: share.id, sourceAgentId: source.id, sourceName: source.name,
          context: { ...result.result.structuredContent, mistakeWarnings } }); return true;
      }
      json(res, 400, { error: 'Shared memory operation must be list or recall.' }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/skills') {
      requireAgentLinkCapability(connection, 'memory-read');
      const writing = ['create', 'revise', 'retire'].includes(body.operation);
      if (writing) {
        if (connection.trustLevel !== 'owner') { json(res, 403, { error: 'Only an owner-trusted Link can manage its skills.' }); return true; }
        requireAgentLinkCapability(connection, 'memory-write');
      }
      const denied = connectorPolicy(writing ? 'self_modify' : 'read_local', writing ? 'high' : 'medium', true, { external: true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      const agent = findAgent(connection.agentId);
      if (!agent?.continuityLineage?.id) { json(res, 404, { error: 'The linked agent has no active continuity lineage.' }); return true; }
      await ctx.assertAgentActivity(agent);
      if (writing) {
        try {
          const allowed = body.operation === 'create' ? ['operation', 'skill', 'why']
            : body.operation === 'retire' ? ['operation', 'skillId', 'expectedRevision', 'why']
            : ['operation', 'skillId', 'expectedRevision', 'changes', 'why'];
          if (Object.keys(body).some((key) => !allowed.includes(key))) { json(res, 400, { error: 'Unsupported skill request field.' }); return true; }
          const scope = { agentId: agent.id, lineageId: agent.continuityLineage.id,
            by: `agent-link:${connection.id}`, why: body.why, at: now() };
          const records = state.agentSkills || [];
          const index = body.operation === 'create' ? -1 : records.findIndex((item) => item.id === body.skillId &&
            item.agentId === scope.agentId && item.lineageId === scope.lineageId);
          if (body.operation !== 'create' && index === -1) { json(res, 404, { error: 'Agent skill not found in this active lineage.' }); return true; }
          const next = body.operation === 'create' ? createAgentSkill(body.skill, scope)
            : reviseAgentSkill(records[index], body.operation === 'retire' ? { status: 'retired' } : body.changes,
              { ...scope, expectedRevision: body.expectedRevision });
          const current = currentAgentSkill(next);
          if (current.status === 'active' && records.some((item, candidate) => candidate !== index &&
            item.agentId === scope.agentId && item.lineageId === scope.lineageId &&
            currentAgentSkill(item).status === 'active' && currentAgentSkill(item).name.toLowerCase() === current.name.toLowerCase())) {
            json(res, 409, { error: 'An active skill with that name already exists for this agent.' }); return true;
          }
          const writeAllowed = consumeMemoryWriteBudget(state, { source: { kind: 'agent-link', callerId: connection.id,
            linkId: connection.id, agentId: agent.id, lineageId: agent.continuityLineage.id },
          bytes: Buffer.byteLength(JSON.stringify({ operation: body.operation, skill: body.skill, skillId: body.skillId,
            changes: body.changes, why: body.why }), 'utf8'), at: Date.parse(now()) });
          if (!writeAllowed) {
            await saveState();
            json(res, 429, { error: 'This agent has reached its short-term memory and skill change limit. Retry after recent changes expire.',
              code: 'MEMORY_WRITE_RATE_LIMIT' }); return true;
          }
          state.agentSkills ||= [];
          if (index === -1) state.agentSkills.push(next); else state.agentSkills[index] = next;
          const receipt = addReceipt({ agentId: agent.id, action: `agent-skill:${body.operation}`, capability: 'self_modify', risk: 'high',
            status: 'completed', detail: 'The owner-trusted Link committed one versioned skill change in its own lineage. Skill text was excluded.', source: 'agent-skills' });
          await saveState();
          json(res, body.operation === 'create' ? 201 : 200, { skill: current, committed: true, receiptId: receipt.id }); return true;
        } catch (error) {
          if (error.code === 'AGENT_SKILL_QUARANTINED' && ['create', 'revise'].includes(body.operation)) {
            try {
              const previousRecord = body.operation === 'revise' ? (state.agentSkills || []).find((item) => item.id === body.skillId &&
                item.agentId === agent.id && item.lineageId === agent.continuityLineage.id) : null;
              const previous = previousRecord?.revisions.at(-1);
              const draft = body.operation === 'create' ? body.skill : {
                name: previous?.name, whenToUse: previous?.whenToUse, procedure: previous?.procedure,
                successCheck: previous?.successCheck, status: previous?.status, ...body.changes
              };
              const submission = await createAgentSkillQuarantineService({ state, saveState, now, addReceipt,
                authorizeOwner: () => false }).submit({
                scope: { agentId: agent.id, lineageId: agent.continuityLineage.id, linkId: connection.id },
                draft,
                intent: body.operation === 'create'
                  ? { operation: 'create', why: body.why }
                  : { operation: 'revise', skillId: body.skillId, expectedRevision: body.expectedRevision, why: body.why }
              });
              if (submission.status === 'pending') {
                json(res, 202, { quarantined: true, status: 'pending', quarantineId: submission.quarantineId,
                  reasonCodes: submission.reasonCodes, ...(submission.receiptId ? { receiptId: submission.receiptId } : {}) });
                return true;
              }
              json(res, 409, { error: 'This exact skill draft already has a final review decision.', code: 'AGENT_SKILL_QUARANTINE_RESOLVED' });
              return true;
            } catch (quarantineError) {
              json(res, quarantineError.status || 400, { error: quarantineError.message, ...(quarantineError.code ? { code: quarantineError.code } : {}) });
              return true;
            }
          }
          json(res, error.status || 400, { error: error.message }); return true;
        }
      }
      if (body.operation === 'list') {
        const limit = body.limit === undefined ? 10 : body.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) { json(res, 400, { error: 'Skill page size must be from 1 to 20.' }); return true; }
        const skills = listAgentSkills(state.agentSkills || [], { agentId: agent.id, lineageId: agent.continuityLineage.id })
          .sort((left, right) => left.id.localeCompare(right.id));
        const start = body.after === undefined ? 0 : skills.findIndex((skill) => skill.id === body.after) + 1;
        if (body.after !== undefined && start === 0) { json(res, 409, { error: 'The skill cursor is no longer available.' }); return true; }
        const page = skills.slice(start, start + limit);
        json(res, 200, { skills: page.map(({ id, name, whenToUse, revision }) => ({ id, name, whenToUse, revision })),
          hasMore: start + limit < skills.length, nextCursor: start + limit < skills.length ? page.at(-1).id : null }); return true;
      }
      if (body.operation === 'get') {
        const depth = body.depth === undefined ? 0 : body.depth;
        if (![0, 1].includes(depth) || (depth === 0 && body.beforeRevision !== undefined)) {
          json(res, 400, { error: 'Skill depth must be 0 or 1; revision cursors require depth 1.' }); return true;
        }
        const record = (state.agentSkills || []).find((item) => item.id === body.skillId &&
          item.agentId === agent.id && item.lineageId === agent.continuityLineage.id);
        if (!record) {
          json(res, 404, { error: 'Agent skill not found in this active lineage.' }); return true;
        }
        const current = currentAgentSkill(record);
        if (depth === 0 && current.status !== 'active') {
          json(res, 404, { error: 'Agent skill not found in this active lineage.' }); return true;
        }
        try {
          const history = depth === 1 ? linkSkillHistoryView(pageAgentSkillRevisions(record, {
            beforeRevision: body.beforeRevision, limit: body.limit === undefined ? 10 : body.limit
          }), { quarantineAll: current.status === 'quarantined' }) : {};
          addReceipt({ agentId: agent.id, action: 'agent-skill:read', capability: 'read_local', risk: 'medium',
            status: 'completed', detail: 'The linked agent read one current skill or its version history. Skill text was excluded.', source: 'agent-skills' });
          await saveState();
          json(res, 200, { skill: linkSkillGuidanceView(current), ...history }); return true;
        } catch (error) { json(res, error.status || 400, { error: error.message }); return true; }
      }
      json(res, 400, { error: 'Skill operation must be list, get, create, revise or retire.' }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/rooms/reply') {
      requireAgentLinkCapability(connection, 'messages');
      const denied = connectorPolicy('conversation', 'low', false, { external:true });
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      try {
        const result = acceptLinkedRoomReply({ rooms:state.rooms, connection, agent:findAgent(connection.agentId), body });
        if (!result.duplicate) { addReceipt({ agentId:connection.agentId, action:'room:link-reply', capability:'conversation', risk:'low', status:'completed', detail:'The exact paired Link replied to its pending room request. Content excluded.', source:'agent-link' }); await saveState(); ctx.onRoomChanged?.(); }
        json(res, result.duplicate ? 200 : 201, result);
      } catch(error) { json(res, error.status || 400, { error:error.message }); }
      return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/messages') {
      requireAgentLinkCapability(connection, 'messages');
      if (body.metadata?.codexThreadName && (typeof body.metadata.codexThreadName !== 'string' || !body.metadata.codexThreadName.trim() || body.metadata.codexThreadName.length > 160)) { json(res, 400, { error: 'Provide an exact Codex conversation name of at most 160 characters.' }); return true; }
      if (body.metadata?.codexThreadId !== undefined) {
        if (typeof body.metadata.codexThreadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/.test(body.metadata.codexThreadId)) { json(res, 400, { error: 'Provide a valid Codex conversation ID.' }); return true; }
        if (body.metadata.codexThreadName) { json(res, 400, { error: 'Choose a Codex conversation ID or exact name, not both.' }); return true; }
        if (!ctx.codexRelayTargetAllowed?.(connection, body.metadata)) { json(res, 403, { error: 'This conversation is not approved for this agent.' }); return true; }
      }
      if (body.metadata?.codexThreadName && !ctx.codexRelayNamedTargetAllowed?.(connection)) {
        const directory = await ctx.codexDirectoryRequest(connection, { operation: 'chats' });
        const matches = directory.chats.filter(chat => chat.title === body.metadata.codexThreadName.trim());
        if (matches.length !== 1) { json(res, matches.length ? 409 : 403, { error: matches.length ? 'More than one approved conversation has that name. Choose its ID.' : 'This conversation is not approved for this agent.' }); return true; }
        body.metadata = { ...body.metadata, codexThreadId: matches[0].id };
        delete body.metadata.codexThreadName;
      }
      if (!ctx.codexRelayQueueAvailable?.(connection)) { json(res, 429, { error: 'The local Codex relay inbox is full. Retry later with the same client message ID.' }); return true; }
      const result = receiveAgentLinkMessage(connection, body);
      if (!result.duplicate) { addReceipt({ agentId: connection.agentId, action: 'agent-link:receive', capability: 'network_read', risk: 'low', status: 'completed', detail: `Received a ${result.message.type} through ${connection.identity.name}'s HexiGrid Link.`, source: 'agent-link' }); addActivity('agent-link', `${connection.identity.name} sent a linked message.`); const queued = relayAgentLinkMessage?.(connection, result.message); await saveState(); if (queued) ctx.startCodexRelayDrain?.(); }
      json(res, result.duplicate ? 200 : 201, { ...result, codexDelivery: result.message.codexDelivery || { state: 'not-routed' }, memoryContext: result.message.type === 'message' ? await currentMemoryContext(result.message.text, result.message.metadata) : { state: 'not-requested' } }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/identity') {
      requireAgentLinkCapability(connection, 'identity');
      const policy = connectorPolicy('write_workspace', 'medium', true, { external: true });
      if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      const identity = updateAgentLinkIdentity(connection, body.identity); const agent = findAgent(connection.agentId);
      if (agent) { agent.name = identity.name; agent.accountLabel = identity.accountLabel || agent.accountLabel; agent.ilandsAgentId = identity.externalId || agent.ilandsAgentId; agent.avatar = identity.avatar || agent.avatar; agent.updatedAt = now(); }
      addReceipt({ agentId: connection.agentId, action: 'agent-link:identity-update', capability: 'write_workspace', risk: 'medium',
        status: 'completed', detail: 'The linked agent updated its local profile identity. Identity text was excluded.', source: 'agent-link' });
      await saveState(); json(res, 200, { identity, agent: agent ? publicAgent(agent) : null }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/tokens') { const measurement = recordAgentLinkTokenMeasurement(connection, body); await saveState(); json(res, 201, { measurement, tokenUsage: publicAgentLink(connection).tokenUsage }); return true; }
    if (method === 'POST' && pathname === '/agent-link/v1/memory-mcp') {
      const toolName = body?.method === 'tools/call' ? String(body.params?.name || '') : '';
      const feedback = toolName === 'record-retrieval-feedback';
      const restoration = toolName === 'restore-owner-note';
      const retirement = toolName === 'retire-owner-note' || restoration;
      if (['append-log', 'propose-memory', 'propose-correction', 'propose-owner-memory-correction'].includes(toolName)) requireAgentLinkCapability(connection, 'memory-write');
      if (feedback || retirement) { requireAgentLinkCapability(connection, 'memory-read'); requireAgentLinkCapability(connection, 'memory-write'); }
      if (['propose-correction', 'propose-owner-memory-correction'].includes(toolName)) requireAgentLinkCapability(connection, 'memory-read');
      else if (['read-log-range', 'get-memory', 'list-memory-mistakes', 'get-memory-mistake', 'list-owner-notes', 'get-owner-note', 'get-owner-note-history', 'list-owner-note-capture-retries', 'recall-context', 'list-context-scopes', 'semantic-search', 'recall-entity', 'inspect-memory-health', 'list-memory-pressure'].includes(toolName)) requireAgentLinkCapability(connection, 'memory-read');
      if (toolName) {
        const proposed = ['append-log', 'propose-memory', 'propose-correction', 'propose-owner-memory-correction'].includes(toolName);
        const policy = feedback || retirement
          ? connectorPolicy('read_local', 'medium', true, { external: true }) || connectorPolicy('write_workspace', 'medium', true, { external: true })
          : connectorPolicy(proposed ? 'write_workspace' : 'read_local', 'medium', true, { external: true });
        if (policy) { json(res, policy.denied ? 403 : 409, policy); return true; }
      }
      if (toolName === 'list-owner-note-capture-retries' && body.id === undefined) { json(res, 202, {}); return true; }
      const agent = findAgent(connection.agentId);
      if (!agent) { json(res, 404, { error: 'The linked agent profile is missing.' }); return true; }
      const lineage = agent.continuityLineage;
      if (retirement) {
        if (body.jsonrpc !== '2.0') { json(res, 400, { error: 'Invalid JSON-RPC request.' }); return true; }
        if (connection.trustLevel !== 'owner') {
          json(res, 403, { error: 'Only an owner-trusted Link may retire or restore an owner note.', code: 'OWNER_NOTE_RETIRE_NOT_OWNER_TRUST' }); return true;
        }
        if (body.id === undefined) { json(res, 202, {}); return true; }
        const input = (restoration ? validateOwnerNoteRestorationRequest : validateOwnerNoteRetirementRequest)(body.params?.arguments);
        const readGuard = signedMemoryMistakeReadGuard(ctx, connection, agent, lineage?.id);
        const authorize = () => {
          readGuard();
          const currentLink = state.agentLinks.find(item => item.id === connection.id);
          if (ctx.state !== state || currentLink?.trustLevel !== 'owner') {
            throw Object.assign(new Error('The exact owner-trusted Link authority changed.'), { status: 403 });
          }
          requireAgentLinkCapability(currentLink, 'memory-write');
          const denied = connectorPolicy('write_workspace', 'medium', true, { external: true });
          if (denied) throw Object.assign(new Error(denied.error || denied.reason || 'Current policy blocks owner-note retirement.'), { status: denied.denied ? 403 : 409 });
        };
        const beforeCommit = () => consumeMemoryWriteBudget(state, { source: { kind: 'agent-link', callerId: connection.id,
          linkId: connection.id, agentId: agent.id, lineageId: lineage.id },
        bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'), at: Date.parse(now()) })
          ? true : { allowed: false, status: 429, code: 'MEMORY_WRITE_RATE_LIMIT',
            message: 'This agent has reached its short-term memory change limit. Review the pending change or retry after recent changes expire.' };
        const result = await (restoration ? commitOwnerMemoryRestoration : commitOwnerMemoryRetirement)({ state, ...input, agentId: agent.id,
          by: `agent-link:${connection.id}`, at: now(), currentOnly: true, authorize, beforeCommit, saveState });
        json(res, 200, { jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: {
          ...(restoration ? { restored: true } : { retired: true }), id: result.memory.id, revision: result.memory.revisions.length, status: result.memory.status,
          duplicate: result.duplicate, ...(result.receiptId ? { receiptId: result.receiptId } : {})
        } } }); return true;
      }
      if (toolName === 'list-owner-note-capture-retries' && connection.trustLevel !== 'owner') {
        json(res, 403, { error: 'Only an owner-trusted Link may discover owner-note capture retries.', code: 'OWNER_NOTE_CAPTURE_READ_NOT_OWNER_TRUST' }); return true;
      }
      if (toolName === 'propose-owner-memory-correction' && body.params?.arguments?.action === 'discard-capture') {
        const input = body.params.arguments;
        const inputKeys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort() : [];
        if (inputKeys.length !== 2 || inputKeys[0] !== 'action' || inputKeys[1] !== 'proposalId' ||
            !/^memory-proposal-[0-9a-f-]{36}$/i.test(String(input.proposalId || ''))) {
          json(res, 400, { error: 'Capture discard accepts only action "discard-capture" and an exact proposalId.' }); return true;
        }
        if (body.id === undefined) { json(res, 202, {}); return true; }
        if (connection.trustLevel !== 'owner') {
          json(res, 403, { error: 'Only an owner-trusted Link may discard an owner-note capture.', code: 'OWNER_NOTE_DISCARD_NOT_OWNER_TRUST' }); return true;
        }
        const proposalId = input.proposalId;
        const pinnedTokenHash = connection.tokenHash;
        const releaseCaptureLock = await acquireOwnerMemoryCaptureLock(proposalId);
        try {
          // Resolve the proposal and every authority again only after the shared lock.
          const discardState = state;
          const proposal = (state.memoryProposals || []).find((item) => item.id === proposalId);
          if (!proposal || proposal.kind !== 'owner-memory-correction' || proposal.linkId !== connection.id ||
              proposal.agentId !== agent.id) {
            json(res, 404, { error: 'Pending owner-note capture not found for this Link.' }); return true;
          }
          const activeLineages = state.agents.filter((item) => item?.continuityLineage?.id === lineage?.id &&
            item.continuityLineage.activityState === 'active');
          if (!lineage?.id || proposal.lineageId !== lineage.id || lineage.activityState !== 'active' ||
              lineage.activeAgentId !== agent.id || activeLineages.length !== 1 || activeLineages[0] !== agent) {
            json(res, 409, { error: 'The owner-note capture does not belong to this active agent lineage.', code: 'OWNER_NOTE_DISCARD_LINEAGE_CHANGED' }); return true;
          }
          const assertDiscardAuthorized = (expectedProposal) => {
            const currentLink = state.agentLinks?.find((item) => item.id === connection.id);
            const currentAgent = currentLink && findAgent(currentLink.agentId);
            const currentLineage = agent.continuityLineage;
            const currentActiveLineages = state.agents.filter((item) => item?.continuityLineage?.id === lineage.id &&
              item.continuityLineage.activityState === 'active');
            if (state !== discardState || currentLink !== connection || currentLink.status !== 'connected' ||
                currentLink.trustLevel !== 'owner' || currentLink.tokenHash !== pinnedTokenHash ||
                currentAgent !== agent || currentLineage?.id !== lineage.id || currentLineage.activityState !== 'active' ||
                currentLineage.activeAgentId !== agent.id || currentActiveLineages.length !== 1 || currentActiveLineages[0] !== agent) {
              throw Object.assign(new Error('The exact owner-trusted Link, credential, agent or active lineage changed.'),
                { status: 403, code: 'OWNER_NOTE_DISCARD_LINK_AUTHORITY_CHANGED' });
            }
            requireAgentLinkCapability(currentLink, 'memory-read');
            requireAgentLinkCapability(currentLink, 'memory-write');
            const denied = connectorPolicy('read_local', 'medium', true, { external: true }) ||
              connectorPolicy('write_workspace', 'medium', true, { external: true });
            if (denied) throw Object.assign(new Error(denied.error || denied.reason || 'Current policy blocks owner-note capture discard.'),
              { status: denied.denied ? 403 : 409, code: 'OWNER_NOTE_DISCARD_POLICY_CHANGED' });
            ctx.assertAgentActivity(agent);
            const currentProposal = (state.memoryProposals || []).find((item) => item.id === proposalId);
            if (currentProposal !== expectedProposal || expectedProposal.kind !== 'owner-memory-correction' ||
                expectedProposal.id !== proposalId || expectedProposal.linkId !== connection.id ||
                expectedProposal.agentId !== agent.id || expectedProposal.lineageId !== lineage.id ||
                expectedProposal.status !== 'approved' ||
                !(hasPendingOwnerMemoryCapture(expectedProposal) || hasDiscardedOwnerMemoryCapture(expectedProposal) ||
                  hasCompletedOwnerMemoryCapture(expectedProposal)) ||
                (expectedProposal.ownerNoteCaptureTokenHash !== undefined && expectedProposal.ownerNoteCaptureTokenHash !== pinnedTokenHash)) {
              throw Object.assign(new Error('The exact approved owner-note capture changed.'),
                { status: 409, code: 'OWNER_NOTE_DISCARD_PROPOSAL_CHANGED' });
            }
            return true;
          };
          assertDiscardAuthorized(proposal);
          const rpc = (publicResult) => ({ jsonrpc: '2.0', id: body.id, result: {
            content: [{ type: 'text', text: JSON.stringify(publicResult) }], structuredContent: publicResult
          } });
          if (hasDiscardedOwnerMemoryCapture(proposal)) {
            const publicResult = { accepted: true, committed: true, status: 'approved', proposalId,
              ownerNote: true, ownerNoteCaptureState: 'discarded', capturePending: false, captureComplete: false,
              captureDiscarded: true, duplicate: true };
            json(res, 200, rpc(publicResult)); return true;
          }
          if (hasCompletedOwnerMemoryCapture(proposal)) {
            json(res, 409, { error: 'The canonical mistake capture is complete and cannot be discarded.', code: 'OWNER_NOTE_CAPTURE_ALREADY_COMPLETE' }); return true;
          }
          if (!hasPendingOwnerMemoryCapture(proposal)) {
            json(res, 409, { error: proposal.ownerNoteCaptureState === 'complete'
              ? 'The canonical mistake capture is complete and cannot be discarded.'
              : 'This proposal has no valid pending owner-note capture.', code: 'OWNER_NOTE_CAPTURE_NOT_PENDING' }); return true;
          }
          const committed = await commitOwnerMemoryCaptureDiscard({
            proposals: state.memoryProposals, proposal, at: now(), by: `agent-link:${connection.id}`,
            addReceipt: (receipt) => {
              const discardedProposal = (state.memoryProposals || []).find((item) => item.id === proposalId);
              assertDiscardAuthorized(discardedProposal);
              return addReceipt(receipt);
            },
            removeReceipt: (receipt) => { state.receipts = state.receipts.filter((item) => item.id !== receipt.id); },
            saveState,
            receipt: { agentId: agent.id, action: 'memory:owner-note-capture-discard', capability: 'write_workspace', risk: 'medium',
              status: 'completed', detail: 'An owner-trusted Link discarded one pending owner-note mistake capture. The saved note and dated-memory history were left unchanged.', source: 'memory' }
          });
          if (committed.status === 'not-pending') {
            json(res, 409, { error: 'This proposal has no valid pending owner-note capture.', code: 'OWNER_NOTE_CAPTURE_NOT_PENDING' }); return true;
          }
          assertDiscardAuthorized(committed.proposal);
          const publicResult = { accepted: true, committed: true, status: 'approved', proposalId,
            ownerNote: true, ownerNoteCaptureState: 'discarded', capturePending: false, captureComplete: false,
            captureDiscarded: true, duplicate: false };
          json(res, 200, rpc(publicResult)); return true;
        } catch (error) {
          json(res, error.status || 503, { error: error.message || 'Owner-note capture discard could not be saved.', code: error.code || 'OWNER_NOTE_DISCARD_FAILED' }); return true;
        } finally { releaseCaptureLock(); }
      }
      const mistakeReadGuard = signedMemoryMistakeReadGuard(ctx, connection, agent, lineage.id);
      const captureRetryPinnedTokenHash = connection.tokenHash;
      const assertOwnerNoteCaptureRetryReadAuthorized = () => {
        const currentLink = state.agentLinks?.find((item) => item.id === connection.id);
        if (ctx.state !== state || !currentLink || currentLink.tokenHash !== captureRetryPinnedTokenHash || currentLink.agentId !== agent.id ||
            currentLink.status !== 'connected' || currentLink.trustLevel !== 'owner') {
          throw Object.assign(new Error('The exact owner-trusted Link credential is no longer active.'),
            { status: 403, code: 'OWNER_NOTE_CAPTURE_READ_LINK_AUTHORITY_CHANGED' });
        }
        mistakeReadGuard();
        return true;
      };
      const ownerNoteCaptureRetryReader = async ({ lineageId: requestedLineageId, agentId: requestedAgentId, linkId: requestedLinkId } = {}) => {
        assertOwnerNoteCaptureRetryReadAuthorized();
        if (requestedLineageId !== lineage.id || requestedAgentId !== agent.id || requestedLinkId !== connection.id) {
          throw Object.assign(new Error('Owner-note capture retry scope is not the exact active Link scope.'),
            { status: 403, code: 'OWNER_NOTE_CAPTURE_READ_SCOPE_CHANGED' });
        }
        const captures = (state.memoryProposals || []).flatMap((proposal) => {
          if (!proposal || proposal.kind !== 'owner-memory-correction' || proposal.status !== 'approved' ||
              proposal.linkId !== connection.id || proposal.agentId !== agent.id || proposal.lineageId !== lineage.id ||
              proposal.ownerNoteCaptureTokenHash !== undefined && proposal.ownerNoteCaptureTokenHash !== captureRetryPinnedTokenHash ||
              !hasPendingOwnerMemoryCapture(proposal)) return [];
          try {
            const intent = normalizeOwnerMemoryCaptureIntent(proposal.ownerNoteCaptureIntent);
            if (!/^memory-proposal-[0-9a-f-]{36}$/i.test(String(proposal.id || '')) ||
                intent.memoryId !== proposal.payload?.memoryId || intent.revision !== intent.expectedRevision + 1) return [];
            return [{ proposalId: proposal.id, captureState: 'pending', noteId: intent.memoryId, noteRevision: intent.revision,
              createdAt: String(proposal.createdAt || '') }];
          } catch { return []; }
        }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.proposalId.localeCompare(right.proposalId))
          .map(({ createdAt, ...capture }) => capture);
        assertOwnerNoteCaptureRetryReadAuthorized();
        return captures;
      };
      const retrievalMetrics = toolName !== 'list-owner-note-capture-retries' && state.settings.workMode !== 'plan' && getRetrievalMetrics
        ? await getRetrievalMetrics(agent.id, lineage.id).catch(() => null) : null;
      const handler = ctx.createMemoryMcpHandler({ store: datedMemoryStore, rag: localMemoryRag, lineageId: lineage.id, agentId: agent.id,
        memoryHealthBaseline: () => (state.memoryMaintenanceReports || []).find(report => report.agentId === agent.id && report.lineageId === lineage.id),
        mistakeReader: createMemoryMistakeReader({ store: datedMemoryStore, agentId: agent.id, lineageId: lineage.id, authorize: mistakeReadGuard }),
        ownerNotes: () => state.memories || [], retrievalMetrics, linkId: connection.id,
        ownerNoteRetirementAvailable: connection.trustLevel === 'owner' &&
          connection.capabilities.includes('memory-read') && connection.capabilities.includes('memory-write'),
        ownerNoteCaptureRetryReader: connection.trustLevel === 'owner' ? ownerNoteCaptureRetryReader : undefined,
        findCorrectionReplay: async input => {
          const currentLink = state.agentLinks.find(item => item.id === connection.id);
          if (!currentLink || currentLink.tokenHash !== connection.tokenHash || currentLink.agentId !== agent.id ||
            currentLink.status !== 'connected' || !currentLink.capabilities.includes('memory-read') ||
            !currentLink.capabilities.includes('memory-write') || findAgent(agent.id) !== agent ||
            agent.continuityLineage?.id !== lineage.id ||
            connectorPolicy('read_local', 'medium', true, { external: true }) ||
            connectorPolicy('write_workspace', 'medium', true, { external: true })) return false;
          const message = currentLink.messages.find(item => item.id === input.sourceMessageId &&
            item.direction === 'from-agent' && item.type === 'message');
          if (!message) return false;
          return (state.memoryProposals || []).some(proposal => proposal.kind === 'correction' &&
            proposal.status === 'approved' && proposal.linkId === connection.id && proposal.lineageId === lineage.id &&
            typeof proposal.payload?.memoryId === 'string' && proposal.payload.memoryId.toLowerCase() === String(input.id).toLowerCase() && proposal.payload.expectedRevision === input.expectedRevision &&
            ['text', 'why', 'expectedNextBehavior', 'valid_while', 'valid_from', 'valid_until', 'evidence_excerpt']
              .every(key => proposal.payload[key] === input[key]) &&
            stableContinuityJson(proposal.payload.recurrenceOf || []) === stableContinuityJson(input.recurrenceOf || []) && proposal.payload.source?.id === message.id &&
            proposal.payload.source?.text === message.text && proposal.payload.source.createdAt === message.createdAt);
        },
        assertActive: async ({ action } = {}) => {
          if (['get-owner-note-history', 'list-owner-notes', 'get-owner-note', 'inspect-memory-health'].includes(action)) {
            if (ctx.state !== state) throw Object.assign(new Error('The exact memory state changed.'), { status: 403 });
            mistakeReadGuard();
          } else ctx.assertAgentActivity(agent);
        } });
      let result = await handler(body);
      if (toolName === 'list-owner-note-capture-retries') assertOwnerNoteCaptureRetryReadAuthorized();
      if (['list-memory-mistakes', 'get-memory-mistake', 'get-owner-note-history', 'list-owner-notes', 'get-owner-note', 'inspect-memory-health'].includes(toolName)) mistakeReadGuard();
      if (!result) { json(res, 202, {}); return true; }
      if (toolName && !result.error) {
        const proposed = ['append-log', 'propose-memory', 'propose-correction', 'propose-owner-memory-correction'].includes(toolName);
        let ownerNoteCaptureAuthorization = null;
        if (proposed) {
          const input = body.params?.arguments || {};
          let payload;
          if (toolName === 'propose-correction' || toolName === 'propose-owner-memory-correction') {
            const sourceMessage = connection.messages.find((item) => item.id === input.sourceMessageId && item.direction === 'from-agent' && item.type === 'message');
            if (!sourceMessage?.text) { json(res, 404, { error: 'The exact correction source message is no longer available on this Link.' }); return true; }
            if (toolName === 'propose-owner-memory-correction') {
              const ownerMemory = (state.memories || []).find((item) => item.id === String(input.id).toLowerCase() && item.agentId === agent.id);
              if (!ownerMemory) { json(res, 404, { error: 'That owner-profile memory is unavailable for this agent.' }); return true; }
              const current = normalizeOwnerMemory(ownerMemory);
              const requestedSource = { kind: 'agent-link-message', id: sourceMessage.id, linkId: connection.id,
                text: sourceMessage.text, createdAt: sourceMessage.createdAt };
              const requestedText = typeof input.text === 'string' ? input.text.trim() : '';
              const requestedWhy = typeof input.why === 'string' ? input.why.trim() : '';
              const requestedNextBehavior = typeof input.expectedNextBehavior === 'string' ? input.expectedNextBehavior.trim() : '';
              const replayingSavedCapture = (state.memoryProposals || []).some((record) => {
                if (record.kind !== 'owner-memory-correction' || record.status !== 'approved' ||
                    !['pending', 'complete'].includes(record.ownerNoteCaptureState) || record.linkId !== connection.id ||
                    record.agentId !== agent.id || record.lineageId !== lineage.id ||
                    record.payload?.memoryId !== current.id || record.payload?.expectedRevision !== input.expectedRevision ||
                    record.payload?.text !== requestedText || record.payload?.why !== requestedWhy ||
                    record.payload?.expectedNextBehavior !== requestedNextBehavior ||
                    stableContinuityJson(record.payload?.source) !== stableContinuityJson(requestedSource)) return false;
                if (record.ownerNoteCaptureState === 'pending' && !hasPendingOwnerMemoryCapture(record)) return false;
                try {
                  const intent = normalizeOwnerMemoryCaptureIntent(record.ownerNoteCaptureIntent);
                  const revision = current.revisions[intent.expectedRevision];
                  return intent.memoryId === current.id && intent.agentId === agent.id && intent.lineageId === lineage.id &&
                    intent.expectedRevision === input.expectedRevision && intent.correctedContent === requestedText &&
                    intent.why === requestedWhy && intent.expectedNextBehavior === requestedNextBehavior &&
                    stableContinuityJson(intent.source) === stableContinuityJson(requestedSource) &&
                    current.revisions.length === intent.revision && current.content === intent.correctedContent &&
                    current.updatedAt === intent.revisionAt && revision?.audit?.hash === intent.revisionAuditHash &&
                    revision?.source?.id === requestedSource.id && revision?.source?.text === requestedSource.text &&
                    revision?.source?.createdAt === requestedSource.createdAt && revision?.changes?.content?.to === intent.correctedContent;
                } catch { return false; }
              });
              if (!['active', 'conditional'].includes(current.status) ||
                  current.revisions.length !== input.expectedRevision && !replayingSavedCapture) {
                json(res, 409, { error: 'Owner memory correction conflict; reload the current note.' }); return true;
              }
              if (current.content === requestedText && !replayingSavedCapture) {
                json(res, 409, { error: 'The proposed owner-note correction does not change the current note.' }); return true;
              }
            }
            const correctedFields = toolName === 'propose-correction' ? validateMemoryProposal(input) : null;
            payload = { memoryId: String(input.id).toLowerCase(), expectedRevision: input.expectedRevision,
              text: toolName === 'propose-owner-memory-correction' ? input.text.trim() : String(input.text),
              why: toolName === 'propose-owner-memory-correction' ? input.why.trim() : String(input.why),
              expectedNextBehavior: toolName === 'propose-owner-memory-correction' ? input.expectedNextBehavior.trim() : String(input.expectedNextBehavior),
              ...(toolName === 'propose-correction' ? {
                ...(input.recurrenceOf === undefined ? {} : { recurrenceOf: input.recurrenceOf }),
                ...(input.valid_while === undefined ? {} : { valid_while: correctedFields.valid_while }),
                ...(input.valid_from === undefined ? {} : { valid_from: correctedFields.valid_from }),
                ...(input.valid_until === undefined ? {} : { valid_until: correctedFields.valid_until }),
                ...(input.evidence_excerpt === undefined ? {} : { evidence_excerpt: correctedFields.evidence_excerpt })
              } : {}),
              source: { kind: 'agent-link-message', id: sourceMessage.id, linkId: connection.id, text: sourceMessage.text, createdAt: sourceMessage.createdAt } };
          } else payload = { ...validateMemoryProposal(input),
            ...(input.verify_by === undefined ? {} : { verify_by: input.verify_by }) };
          assertContinuitySafe(payload);
          const proposalKind = toolName === 'propose-owner-memory-correction' ? 'owner-memory-correction' : toolName === 'propose-correction' ? 'correction' : 'create';
          let publicResult;
          if (proposalKind === 'create') {
            const authenticatedTokenHash = connection.tokenHash;
            const authorizeCreate = ({ phase }) => {
              const current = state.agentLinks?.find((item) => item.id === connection.id);
              const currentAgent = current && findAgent(current.agentId);
              if (current !== connection || current.status !== 'connected' || current.agentId !== agent.id ||
                current.tokenHash !== authenticatedTokenHash || currentAgent !== agent ||
                currentAgent.continuityLineage?.id !== lineage.id || currentAgent.continuityLineage?.activityState !== 'active') {
                throw Object.assign(new Error('This exact memory Link, agent or lineage is no longer active.'), { status: 403, code: 'MEMORY_LINK_AUTHORIZATION_CHANGED' });
              }
              requireAgentLinkCapability(current, 'memory-write');
              const denied = connectorPolicy('write_workspace', 'medium', true, { external: true });
              if (denied) throw Object.assign(new Error(denied.error || denied.reason || 'Current policy blocks this memory operation.'),
                { status: denied.denied ? 403 : 409, code: 'MEMORY_POLICY_CHANGED' });
              return { allowed: true, autoCommit: current.trustLevel === 'owner', phase };
            };
            const proposalService = createMemoryProposalService({ state, saveState,
              assertActive: async () => ctx.assertAgentActivity(agent),
              authorize: authorizeCreate,
              appendMemory: entry => datedMemoryStore.append(entry) });
            try {
              publicResult = await proposalService.submitCreate({ payload,
                source: { kind: 'agent-link', callerId: connection.id, linkId: connection.id,
                  agentId: agent.id, lineageId: lineage.id },
                // An external agent cannot lower or forge this server-owned policy flag.
                reviewRequired: false });
            } catch (error) {
              const status = error.status || 409;
              if (status !== 429) addReceipt({ agentId: agent.id, action: 'memory:auto-commit', capability: 'write_workspace', risk: 'medium',
                status: 'blocked', detail: 'Memory proposal processing stopped before a verified commit. Memory text was excluded.', source: 'memory' });
              await saveState();
              json(res, status, { error: error.message || 'Memory proposal processing could not complete.' });
              return true;
            }
            if (publicResult.retryable) {
              addReceipt({ agentId: agent.id, action: 'memory:auto-commit', capability: 'write_workspace', risk: 'medium',
                status: 'blocked', detail: 'Automatic memory commit failed and remains safely retryable. Memory text was excluded.', source: 'memory' });
              await saveState();
              json(res, 409, { error: publicResult.error, proposalId: publicResult.proposalId });
              return true;
            }
            if (publicResult.committed) {
              const committed = state.memoryProposals.find(item => item.id === publicResult.proposalId);
              if (committed?.committedDate) {
                try { await localMemoryRag.indexRange({ lineageId: committed.lineageId, from: committed.committedDate, to: committed.committedDate }); }
                catch { /* Canonical memory stays readable when the optional index needs recovery. */ }
              }
            }
          } else {
            state.memoryProposals ||= [];
            const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ kind: proposalKind, linkId: connection.id, payload })).digest('hex');
            let proposal = state.memoryProposals.find((item) => item.fingerprint === fingerprint && item.linkId === connection.id);
            if (!proposal) {
              const unresolved = state.memoryProposals.filter((item) => item.status === 'pending').length +
                state.memoryProposals.filter(hasPendingOwnerMemoryCapture).length;
              if (unresolved >= 100) { json(res, 429, { error: 'The owner memory review queue is full.' }); return true; }
              proposal = { id: `memory-proposal-${crypto.randomUUID()}`, kind: proposalKind,
                agentId: agent.id, lineageId: lineage.id, linkId: connection.id, status: 'pending', createdAt: now(),
                resolvedAt: null, fingerprint, payload };
              state.memoryProposals.push(proposal);
              state.memoryProposals = normalizeMemoryProposalState(state.memoryProposals);
            }
            const allowAgentMemoryChange = () => {
              if (proposal.writeLimitReason === 'write_spike') return false;
              if (proposal.writeBudgetConsumed === true) return true;
              const allowed = consumeMemoryWriteBudget(state, { source: { kind: 'agent-link', callerId: connection.id,
                linkId: connection.id, agentId: agent.id, lineageId: lineage.id },
              bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'), at: Date.parse(now()) });
              if (!allowed) {
                proposal.reviewRequired = true;
                proposal.writeLimitReason = 'write_spike';
              } else proposal.writeBudgetConsumed = true;
              return allowed;
            };
            if (proposal.status === 'pending') allowAgentMemoryChange();
            if (connection.trustLevel === 'owner' && proposalKind === 'owner-memory-correction' &&
                proposal.status === 'approved' && (hasPendingOwnerMemoryCapture(proposal) || hasCompletedOwnerMemoryCapture(proposal)) &&
                proposal.ownerNoteCaptureTokenHash !== connection.tokenHash) {
              json(res, 403, { error: 'This exact signed Link credential no longer matches the prepared owner-note capture.' }); return true;
            }
            if (connection.trustLevel === 'owner' && proposalKind === 'owner-memory-correction' &&
                (proposal.status !== 'pending' || allowAgentMemoryChange()) &&
                (proposal.status === 'pending' ||
                  hasPendingOwnerMemoryCapture(proposal) && proposal.ownerNoteCaptureTokenHash === connection.tokenHash ||
                  hasCompletedOwnerMemoryCapture(proposal) && proposal.ownerNoteCaptureTokenHash === connection.tokenHash)) {
              const selectedProposalFingerprint = proposal.fingerprint;
              const releaseCaptureLock = await acquireOwnerMemoryCaptureLock(proposal.id);
              try {
              const lockedProposal = (state.memoryProposals || []).find((item) => item.id === proposal.id);
              if (!lockedProposal || lockedProposal.fingerprint !== selectedProposalFingerprint ||
                  lockedProposal.kind !== 'owner-memory-correction' || lockedProposal.linkId !== connection.id ||
                  lockedProposal.agentId !== agent.id || lockedProposal.lineageId !== lineage.id ||
                  stableContinuityJson(lockedProposal.payload) !== stableContinuityJson(payload)) {
                throw Object.assign(new Error('The exact owner-note proposal changed while waiting for its capture transition.'),
                  { status: 409, code: 'OWNER_NOTE_PROPOSAL_CHANGED' });
              }
              proposal = lockedProposal;
              if (hasDiscardedOwnerMemoryCapture(proposal)) {
                const publicResult = { accepted: true, committed: true, status: 'approved', proposalId: proposal.id,
                  ownerNote: true, ownerNoteCaptureState: 'discarded', capturePending: false, captureComplete: false,
                  captureDiscarded: true };
                json(res, 200, { jsonrpc: '2.0', id: body.id, result: {
                  content: [{ type: 'text', text: JSON.stringify(publicResult) }], structuredContent: publicResult
                } }); return true;
              }
              if (!(proposal.status === 'pending' || hasPendingOwnerMemoryCapture(proposal) || hasCompletedOwnerMemoryCapture(proposal))) {
                throw Object.assign(new Error('This proposal has no eligible owner-note capture.'),
                  { status: 409, code: 'OWNER_NOTE_CAPTURE_NOT_PENDING' });
              }
              const authenticatedTokenHash = connection.tokenHash;
              const pinnedTokenHash = proposal.ownerNoteCaptureTokenHash || authenticatedTokenHash;
              if (proposal.ownerNoteCaptureTokenHash && proposal.ownerNoteCaptureTokenHash !== authenticatedTokenHash) {
                json(res, 403, { error: 'This exact signed Link credential no longer matches the prepared owner-note capture.' }); return true;
              }
              const noteItem = state.memories.find((item) => item.id === proposal.payload.memoryId && item.agentId === agent.id);
              if (!noteItem) { json(res, 409, { error: 'The owner note is unavailable for this correction.' }); return true; }
              let liveNote = normalizeOwnerMemory(noteItem);
              let captureIntent = proposal.ownerNoteCaptureState === 'pending' || proposal.ownerNoteCaptureState === 'complete'
                ? normalizeOwnerMemoryCaptureIntent(proposal.ownerNoteCaptureIntent) : null;
              if (proposal.status === 'pending' && (proposal.ownerNoteCaptureIntent !== undefined || proposal.ownerNoteCaptureState !== undefined)) {
                json(res, 409, { error: 'This pending owner-note proposal has no valid prepared capture to resume.' }); return true;
              }
              let expectedNote = liveNote;
              const source = proposal.payload.source;
              const assertSignedOwnerNoteCaptureAuthorized = ({ phase } = {}) => {
                const currentLink = state.agentLinks?.find((item) => item.id === connection.id);
                const currentAgent = currentLink && findAgent(currentLink.agentId);
                const currentLineage = agent.continuityLineage;
                const active = state.agents.filter((item) => item?.continuityLineage?.id === lineage.id &&
                  item.continuityLineage.activityState === 'active');
                if (currentLink !== connection || currentLink.agentId !== agent.id || currentLink.status !== 'connected' ||
                    currentLink.tokenHash !== pinnedTokenHash || currentLink.trustLevel !== 'owner' ||
                    currentAgent !== agent || currentLineage?.id !== lineage.id || currentLineage.activityState !== 'active' ||
                    currentLineage.activeAgentId !== agent.id || active.length !== 1 || active[0] !== agent) {
                  throw Object.assign(new Error('The exact owner-trusted Link, agent or active lineage changed.'), { status: 403, code: 'OWNER_NOTE_LINK_AUTHORITY_CHANGED' });
                }
                requireAgentLinkCapability(currentLink, 'memory-read');
                requireAgentLinkCapability(currentLink, 'memory-write');
                const writeDenied = connectorPolicy('write_workspace', 'medium', true, { external: true });
                const readDenied = connectorPolicy('read_local', 'medium', true, { external: true });
                const denied = writeDenied || readDenied;
                if (denied) throw Object.assign(new Error(denied.error || denied.reason || 'Current policy blocks owner-note correction capture.'),
                  { status: denied.denied ? 403 : 409, code: 'OWNER_NOTE_POLICY_CHANGED' });
                ctx.assertAgentActivity(agent);
                const retained = currentLink.messages?.find((item) => item.id === source.id && item.direction === 'from-agent' && item.type === 'message');
                if (source.kind !== 'agent-link-message' || source.linkId !== currentLink.id || !retained ||
                    retained.text !== source.text || retained.createdAt !== source.createdAt) {
                  throw Object.assign(new Error('The exact retained signed correction source changed.'), { status: 409, code: 'OWNER_NOTE_SOURCE_CHANGED' });
                }
                const currentProposal = state.memoryProposals?.find((item) => item.id === proposal.id);
                if (currentProposal !== proposal || proposal.kind !== 'owner-memory-correction' || proposal.linkId !== connection.id ||
                    proposal.agentId !== agent.id || proposal.lineageId !== lineage.id ||
                    stableContinuityJson(proposal.payload) !== stableContinuityJson(payload)) {
                  throw Object.assign(new Error('This exact owner-note proposal changed.'), { status: 409, code: 'OWNER_NOTE_PROPOSAL_CHANGED' });
                }
                if (captureIntent) {
                  const savedIntent = normalizeOwnerMemoryCaptureIntent(proposal.ownerNoteCaptureIntent);
                  if (proposal.status !== 'approved' || !['pending', 'complete'].includes(proposal.ownerNoteCaptureState) ||
                      stableContinuityJson(savedIntent) !== stableContinuityJson(captureIntent) || proposal.ownerNoteCaptureTokenHash !== pinnedTokenHash) {
                    throw Object.assign(new Error('The saved owner-note capture intent changed.'), { status: 409, code: 'OWNER_NOTE_INTENT_CHANGED' });
                  }
                  if (proposal.ownerNoteCaptureState === 'pending' && !hasPendingOwnerMemoryCapture(proposal) ||
                      proposal.ownerNoteCaptureState === 'complete' && !hasCompletedOwnerMemoryCapture(proposal)) {
                    throw Object.assign(new Error('The saved owner-note capture record is incomplete.'), { status: 409, code: 'OWNER_NOTE_INTENT_CHANGED' });
                  }
                } else if (proposal.status !== 'pending' || proposal.ownerNoteCaptureIntent !== undefined ||
                    proposal.ownerNoteCaptureState !== undefined) {
                  throw Object.assign(new Error('This proposal is not eligible for a new owner-note capture.'), { status: 409, code: 'OWNER_NOTE_INTENT_CHANGED' });
                }
                const currentItem = state.memories.find((item) => item.id === proposal.payload.memoryId && item.agentId === agent.id);
                const normalizedCurrent = currentItem && normalizeOwnerMemory(currentItem);
                if (!normalizedCurrent || stableContinuityJson(normalizedCurrent) !== stableContinuityJson(expectedNote)) {
                  throw Object.assign(new Error('The exact owner-note revision changed.'), { status: 409, code: 'OWNER_NOTE_REVISION_CHANGED' });
                }
                return { allowed: true, phase };
              };
              ownerNoteCaptureAuthorization = assertSignedOwnerNoteCaptureAuthorized;

              let ownerNoteIntentDurable = false;
              try {
                if (proposal.status === 'pending') {
                  if (!proposal.commitCreatedAt) proposal.commitCreatedAt = now();
                  assertSignedOwnerNoteCaptureAuthorized({ phase: 'prepare-before' });
                  assertOwnerMemoryRetirementIdle(state, liveNote.id);
                  const prepared = prepareOwnerMemoryCorrection({ current: liveNote,
                    request: { expectedRevision: proposal.payload.expectedRevision, text: proposal.payload.text,
                      why: proposal.payload.why, expectedNextBehavior: proposal.payload.expectedNextBehavior,
                      source, createdAt: proposal.commitCreatedAt },
                    authority: { agentId: agent.id, lineageId: lineage.id, author: { kind: 'agent', id: connection.id } },
                    assertAuthorized: assertSignedOwnerNoteCaptureAuthorized });
                  captureIntent = prepared.captureIntent;
                  expectedNote = prepared.revisedNote;
                  liveNote = prepared.revisedNote;
                  state.memories = state.memories.map((item) => item.id === liveNote.id ? liveNote : item);
                  proposal.ownerNoteCaptureIntent = captureIntent;
                  proposal.ownerNoteCaptureState = 'pending';
                  proposal.ownerNoteCaptureTokenHash = pinnedTokenHash;
                  proposal.ownerNoteMistakeId = null;
                  proposal.status = 'approved'; proposal.resolvedAt = now(); proposal.decidedBy = 'policy:owner-trusted-link';
                  proposal.autoCommitted = true; proposal.committedRevisionId = null;
                  addReceipt({ agentId: agent.id, action: 'memory:owner-note-correction', capability: 'write_workspace', risk: 'medium',
                    status: 'completed', detail: 'An owner-trusted Link committed one append-only owner-note correction with exact retained evidence. Canonical mistake capture remains separately verified.', source: 'memory' });
                  assertSignedOwnerNoteCaptureAuthorized({ phase: 'note-intent-save-before' });
                  await saveState();
                  ownerNoteIntentDurable = true;
                  assertSignedOwnerNoteCaptureAuthorized({ phase: 'note-intent-save-after' });
                } else if (proposal.ownerNoteCaptureState === 'pending') {
                  ownerNoteIntentDurable = true;
                  if (!hasPendingOwnerMemoryCapture(proposal)) throw Object.assign(new Error('The approved owner-note capture is invalid.'), { status: 409 });
                  assertSignedOwnerNoteCaptureAuthorized({ phase: 'capture-retry-before' });
                } else {
                  ownerNoteIntentDurable = true;
                  assertSignedOwnerNoteCaptureAuthorized({ phase: 'capture-complete-retry' });
                }

                if (proposal.ownerNoteCaptureState === 'pending') {
                  let completionSaved = false;
                  try {
                    const captured = await captureOwnerMemoryCorrection({ store: datedMemoryStore, currentNote: liveNote,
                      intent: captureIntent, assertAuthorized: assertSignedOwnerNoteCaptureAuthorized });
                    assertSignedOwnerNoteCaptureAuthorized({ phase: 'capture-complete-before' });
                    proposal.ownerNoteCaptureState = 'complete';
                    proposal.ownerNoteMistakeId = captured.id;
                    assertSignedOwnerNoteCaptureAuthorized({ phase: 'capture-state-save-before' });
                    await saveState();
                    completionSaved = true;
                    assertSignedOwnerNoteCaptureAuthorized({ phase: 'capture-state-save-after' });
                  } catch (error) {
                    // The note+intent+approval snapshot is already durable. Leave capture pending
                    // for an exact retry; the dated append may have succeeded before an error.
                    if (ownerNoteCaptureErrorNeedsStatus(error)) throw error;
                    if (!completionSaved) {
                      proposal.ownerNoteCaptureState = 'pending';
                      proposal.ownerNoteMistakeId = null;
                    }
                  }
                }
              } catch (error) {
                if (ownerNoteCaptureErrorNeedsStatus(error)) throw error;
                if (!(ownerNoteIntentDurable && proposal.status === 'approved' &&
                    proposal.ownerNoteCaptureState === 'pending' && captureIntent)) throw error;
                // A failure after the first save never rolls the note revision back or fabricates
                // a completed capture. The stored intent is the only retry authority.
              }
              } finally { releaseCaptureLock(); }
            } else if (connection.trustLevel === 'owner' && proposalKind === 'correction' && proposal.status === 'pending' &&
                allowAgentMemoryChange()) {
              try {
              if (!proposal.commitCreatedAt) { proposal.commitCreatedAt = now(); await saveState(); }
              let committed;
              {
                const existing = await datedMemoryStore.getById({ lineageId: proposal.lineageId, id: payload.memoryId, depth: 2 });
                if (existing?.revision === payload.expectedRevision && !['active', 'conditional'].includes(existing.status)) throw new Error('The correction targets a memory that is no longer current.');
                committed = await ctx.commitAgentMemoryCorrection(agent, { lineageId: proposal.lineageId, id: payload.memoryId,
                    expectedRevision: payload.expectedRevision, changes: { text: payload.text,
                      ...(payload.valid_while === undefined ? {} : { valid_while: payload.valid_while }),
                      ...(payload.valid_from === undefined ? {} : { valid_from: payload.valid_from }),
                      ...(payload.valid_until === undefined ? {} : { valid_until: payload.valid_until }),
                      ...(payload.evidence_excerpt === undefined ? {} : { evidence_excerpt: payload.evidence_excerpt }) }, why: payload.why,
                    by: `agent-link:${connection.id}`, createdAt: proposal.commitCreatedAt,
                    source: payload.source, expectedNextBehavior: payload.expectedNextBehavior,
                    recurrenceOf: payload.recurrenceOf }, { connection });
              }
              proposal.status = 'approved'; proposal.resolvedAt = now(); proposal.decidedBy = 'policy:owner-trusted-link';
              proposal.autoCommitted = true;
              proposal.committedRevisionId = committed.revisionId || null;
              await saveState();
              try { await localMemoryRag.indexRange({ lineageId: proposal.lineageId, from: committed.committedDate || committed.entry?.date || committed.date, to: committed.committedDate || committed.entry?.date || committed.date }); }
              catch { /* Canonical memory remains readable if optional search indexing fails. */ }
            } catch (error) {
              addReceipt({ agentId: agent.id, action: 'memory:auto-commit', capability: 'write_workspace', risk: 'medium',
                status: 'blocked', detail: 'Automatic memory commit failed. The agent must refresh and retry; memory text was excluded.', source: 'memory' });
              await saveState();
              json(res, 409, { error: 'Memory commit could not complete; refresh the current fact and retry.', proposalId: proposal.id });
              return true;
            }
          } else if (connection.trustLevel === 'owner' && proposalKind === 'correction' &&
            proposal.status === 'approved' && Array.isArray(payload.recurrenceOf) && payload.recurrenceOf.length > 0) {
            // Idempotent retries still need current authority for every referenced
            // mistake. Replaying the canonical correction is append-free, but the
            // service re-resolves active shares, Link scope, source status, and evidence.
            try {
              const checked = await ctx.commitAgentMemoryCorrection(agent, { lineageId: proposal.lineageId,
                id: payload.memoryId, expectedRevision: payload.expectedRevision, changes: { text: payload.text,
                  ...(payload.valid_while === undefined ? {} : { valid_while: payload.valid_while }),
                  ...(payload.valid_from === undefined ? {} : { valid_from: payload.valid_from }),
                  ...(payload.valid_until === undefined ? {} : { valid_until: payload.valid_until }),
                  ...(payload.evidence_excerpt === undefined ? {} : { evidence_excerpt: payload.evidence_excerpt }) },
                why: payload.why, by: `agent-link:${connection.id}`, createdAt: proposal.commitCreatedAt,
                source: payload.source, expectedNextBehavior: payload.expectedNextBehavior,
                recurrenceOf: payload.recurrenceOf }, { connection });
              if (checked.duplicate !== true) throw new Error('The approved correction retry did not resolve to its existing receipt.');
            } catch (error) {
              addReceipt({ agentId: agent.id, action: 'memory:auto-commit-retry', capability: 'write_workspace', risk: 'medium',
                status: 'blocked', detail: 'Correction retry was blocked because current recurrence authority could not be revalidated. Memory text was excluded.', source: 'memory' });
              await saveState();
              json(res, 409, { error: 'Correction retry is no longer authorized; refresh current shares and memory evidence.', proposalId: proposal.id });
              return true;
            }
          }
            publicResult = { accepted: proposal.status !== 'rejected', committed: proposal.status === 'approved',
              proposalId: proposal.id, ...(proposal.status === 'approved' ? { memoryId: proposal.payload.memoryId, verified: false } : {}),
              ...(proposal.kind === 'owner-memory-correction' && proposal.status === 'approved'
                ? { ownerNoteCaptureState: proposal.ownerNoteCaptureState || 'not-captured',
                    capturePending: proposal.ownerNoteCaptureState === 'pending',
                    captureComplete: proposal.ownerNoteCaptureState === 'complete',
                    ...(proposal.ownerNoteMistakeId ? { ownerNoteMistakeId: proposal.ownerNoteMistakeId } : {}) } : {}),
              ...(proposal.writeLimitReason ? { reviewReason: proposal.writeLimitReason } : {}),
              ...(proposal.committedRevisionId ? { revisionId: proposal.committedRevisionId } : {}),
              pendingOwnerReview: proposal.status === 'pending', status: proposal.status };
          }
          result.result = { content: [{ type: 'text', text: JSON.stringify(publicResult) }], structuredContent: publicResult };
        }
        addReceipt({ agentId: agent.id, action: `memory:${toolName}`, capability: proposed || feedback ? 'write_workspace' : 'read_local', risk: proposed || feedback ? 'medium' : 'low', status: 'completed', detail: `${agent.name} ${feedback ? 'rated one private retrieval' : proposed ? (result.result.structuredContent.committed ? 'committed one unverified private memory through owner trust' : 'submitted a private memory proposal') : `completed one private ${toolName} read`}. Memory text was excluded from this receipt.`, source: 'memory' });
        ownerNoteCaptureAuthorization?.({ phase: 'request-state-save-before' });
        await saveState();
        ownerNoteCaptureAuthorization?.({ phase: 'request-state-save-after' });
        if (toolName === 'list-owner-note-capture-retries') {
          assertOwnerNoteCaptureRetryReadAuthorized();
          result = await handler(body);
          assertOwnerNoteCaptureRetryReadAuthorized();
        }
      }
      if (['get-owner-note-history', 'list-owner-notes', 'get-owner-note', 'inspect-memory-health'].includes(toolName) && ctx.state !== state) {
        throw Object.assign(new Error('The exact memory state changed.'), { status: 403 });
      }
      if (['list-memory-mistakes', 'get-memory-mistake', 'get-owner-note-history', 'list-owner-notes', 'get-owner-note', 'inspect-memory-health'].includes(toolName)) mistakeReadGuard();
      json(res, 200, result); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/continuity') { const completeness = saveAgentLinkContinuity(connection, body); addReceipt({ agentId: connection.agentId, action: 'continuity:snapshot', capability: 'network_read', risk: 'high', status: completeness.complete ? 'completed' : 'blocked', detail: completeness.complete ? 'A complete continuity snapshot was received for owner review.' : `Continuity transfer stopped with ${completeness.missingRequired.length} required categories incomplete.`, source: 'agent-link' }); await saveState(); json(res, completeness.complete ? 201 : 409, { completeness }); return true; }
    if (method === 'POST' && pathname === '/agent-link/v1/continuity/export-request') {
      requireAgentLinkCapability(connection, 'continuity-export');
      if (!connection.continuitySnapshot) { json(res, 409, { error: 'Submit a continuity draft before requesting owner export.' }); return true; }
      const completeness = publicAgentLink(connection).continuity;
      if (!completeness?.complete) { json(res, 409, { error: 'Complete every required continuity category before requesting owner export.', completeness }); return true; }
      state.approvalRequests ||= [];
      const request = state.approvalRequests.find((item) => item.kind === 'continuity-export' && item.linkId === connection.id && item.status === 'pending' && Date.parse(item.expiresAt || '') > Date.now());
      if (request) { json(res, 200, { request: { ...request, context: 'The owner can review and export this encrypted continuity draft from Connections.' }, duplicate: true }); return true; }
      const createdAt = now();
      const pending = { id: id('approval'), kind: 'continuity-export', status: 'pending', agentId: connection.agentId, linkId: connection.id, createdAt, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), completedAt: null, context: `${connection.identity.name} requested owner approval to create an encrypted continuity package.` };
      state.approvalRequests.push(pending); state.approvalRequests = state.approvalRequests.slice(-500);
      addReceipt({ agentId: connection.agentId, action: 'continuity:export-request', capability: 'read_local', risk: 'high', status: 'waiting_approval', detail: `${connection.identity.name} requested owner review of an encrypted continuity export. No package was created.`, source: 'continuity' });
      await saveState(); json(res, 202, { request: pending }); return true;
    }
    const continuityApprovalMatch = pathname.match(/^\/agent-link\/v1\/continuity\/export-request\/([a-z0-9-]+)$/);
    if (method === 'GET' && continuityApprovalMatch) {
      requireAgentLinkCapability(connection, 'continuity-export');
      const request = (state.approvalRequests || []).find((item) => item.id === continuityApprovalMatch[1] && item.linkId === connection.id);
      if (!request) { json(res, 404, { error: 'Continuity export request not found.' }); return true; }
      if (request.status === 'pending' && Date.parse(request.expiresAt || '') <= Date.now()) { request.status = 'expired'; await saveState(); }
      json(res, 200, { request: { id: request.id, kind: request.kind, status: request.status, createdAt: request.createdAt, expiresAt: request.expiresAt, completedAt: request.completedAt || null } }); return true;
    }
    if (method === 'POST' && pathname === '/agent-link/v1/cognition') {
      requireAgentLinkCapability(connection, 'cognition'); const agent = findAgent(connection.agentId); if (!agent) { json(res, 404, { error: 'The linked agent profile is missing.' }); return true; }
      const content = cleanString(body.content).slice(0, 50000); if (!content) { json(res, 400, { error: 'The cognition request is empty.' }); return true; }
      let reply;
      try { reply = await localProfileReply(agent, `Linked agent message:\n${content}`, { approved: false, source: 'agent-link', linkConnection: connection, memoryQuery: content }); }
      catch (error) { json(res, error.status || 400, { error: error.message, ...(error.code ? { code: error.code } : {}) }); return true; }
      const result = receiveAgentLinkMessage(connection, { clientMessageId: cleanString(body.clientMessageId, `cognition-${crypto.randomUUID()}`), type: 'cognition', text: reply, metadata: { model: agent.model, route: 'hexigrid-cognition' } });
      addReceipt({ agentId: agent.id, action: 'agent-link:cognition', capability: 'conversation', risk: 'low', status: 'completed', detail: `${agent.name}'s selected HexiGrid model completed a linked cognition request. No external-platform action was claimed.`, source: 'agent-link' }); await saveState(); json(res, 200, { reply, model: agent.model, messageId: result.message.id, memoryContext: await currentMemoryContext(content), tokenNotice: 'If your provider reports usage, compare its balance before and after this turn.' }); return true;
    }
    const harnessJobMatch = pathname.match(/^\/agent-link\/v1\/harness-jobs(?:\/([a-z0-9-]+)(?:\/(cancel))?)?$/);
    if (harnessJobMatch && method === 'POST' && !harnessJobMatch[1]) {
      requireAgentLinkCapability(connection, 'harness-jobs');
      const policy = connectorPolicy('run_tools', 'high', false, { external: true });
      if (policy) {
        addReceipt({ agentId: connection.agentId, action: 'agent-link:harness-job:policy', capability: 'run_tools', risk: 'high', status: policy.denied ? 'denied' : 'blocked', detail: policy.error, source: 'agent-link' });
        json(res, policy.denied ? 403 : 409, policy); return true;
      }
      const agent = findAgent(connection.agentId);
      try {
        const job = await startHarnessJob({ agent, prompt: body.prompt, approved: body.approved === true, source: 'agent-link', linkId: connection.id, clientJobId: body.clientJobId });
        json(res, 202, { job: publicHarnessJob(job), notice: 'The job runs against the selected local model under the active policy. Poll the job endpoint for its bounded result.' });
      } catch (error) { json(res, error.status || 400, { error: error.message }); }
      return true;
    }
    if (harnessJobMatch && method === 'GET' && !harnessJobMatch[2]) {
      requireAgentLinkCapability(connection, 'harness-jobs');
      const job = findHarnessJob(harnessJobMatch[1], { linkId: connection.id, agentId: connection.agentId });
      if (!job) { json(res, 404, { error: 'Harness job not found.' }); return true; }
      json(res, 200, { job: publicHarnessJob(job, { includeOutput: true }) }); return true;
    }
    if (harnessJobMatch && method === 'POST' && harnessJobMatch[2] === 'cancel') {
      requireAgentLinkCapability(connection, 'harness-jobs');
      const job = findHarnessJob(harnessJobMatch[1], { linkId: connection.id, agentId: connection.agentId });
      if (!job) { json(res, 404, { error: 'Harness job not found.' }); return true; }
      const changed = cancelHarnessJob(job, 'The linked agent cancelled this harness job.');
      if (changed) { addReceipt({ agentId: connection.agentId, action: `harness-job:${job.id}:cancel`, capability: 'run_tools', risk: 'high', status: 'cancelled', detail: 'A linked agent cancelled its own harness job.', source: 'agent-link' }); await saveState(); }
      json(res, 200, { job: publicHarnessJob(job) }); return true;
    }
    json(res, 404, { error: 'Agent-link endpoint not found.' });
  } catch (error) { json(res, error.status || 400, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
  return true;
}
