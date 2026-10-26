import crypto from 'node:crypto';
import { validateCallChatSelection } from './call-browser.mjs';

export async function handleCallBrowserRequest(req, res, { pathname, method, url, secret, isHostRequest,
  safeEqual, json, readBody, state, bridge, policy, authorize, receipt, saveState, headers }) {
  if (!pathname.startsWith('/api/call-browser/v1/')) return false;
  if (!isHostRequest(req) || req.headers.origin || req.headers['sec-fetch-site']) {
    json(res, 403, { error: 'The call chat connection is available only through the local browser companion.' }); return true;
  }
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
  if (!secret || !safeEqual(secret, bearer)) { json(res, 401, { error: 'The local browser companion is not connected.' }); return true; }
  const bindings = () => state().settings.callBrowserBindings ||= [];
  try {
    if (method === 'GET' && pathname.endsWith('/links')) {
      json(res, 200, { links: state().agentLinks.filter(x => x.status === 'connected' && x.capabilities.includes('microphone-listen') && x.capabilities.includes('speaker-output'))
        .map(x => ({ id: x.id, name: x.identity.name })) }); return true;
    }
    const body = method === 'POST' ? await readBody(req, 32 * 1024) : {};
    if (method === 'POST' && pathname.endsWith('/connect')) {
      const denied = policy();
      if (denied) { json(res, 403, denied); return true; }
      const selection = validateCallChatSelection(body);
      const link = state().agentLinks.find(x => x.id === selection.linkId && x.status === 'connected');
      if (!link || !link.capabilities.includes('microphone-listen') || !link.capabilities.includes('speaker-output')) throw new Error('This agent does not have approved call access.');
      const old = bindings().find(x => x.linkId === selection.linkId);
      if (old) bridge.disconnect(old.id);
      const binding = { ...selection, id: crypto.randomUUID(), enabled: true };
      state().settings.callBrowserBindings = bindings().filter(x => x.linkId !== selection.linkId).concat(binding);
      receipt(binding, 'completed', 'The owner connected this agent’s selected browser chat for calls.');
      await saveState(); json(res, 200, { binding }); return true;
    }
    const binding = bindings().find(x => x.id === (body.bindingId || url.searchParams.get('bindingId')) && x.enabled);
    if (!binding) { json(res, 409, { error: 'Connect the selected agent chat again.' }); return true; }
    if (method === 'POST' && pathname.endsWith('/disconnect')) {
      binding.enabled = false; bridge.disconnect(binding.id);
      receipt(binding, 'completed', 'The browser call chat connection was disconnected.');
      await saveState(); json(res, 200, { disconnected: true }); return true;
    }
    if (method === 'GET' && pathname.endsWith('/events')) {
      res.writeHead(200, { ...headers('text/event-stream'), connection: 'keep-alive' });
      res.write(': connected\n\n'); bridge.subscribe(binding, res);
      const timer = setInterval(() => {
        const link = state().agentLinks.find(x => x.id === binding.linkId && x.status === 'connected');
        if (!binding.enabled || !bindings().includes(binding) || !link || policy()) { res.end(); return; }
        res.write(': keepalive\n\n'); bridge.prune();
      }, 10_000); timer.unref?.(); res.once('close', () => clearInterval(timer)); return true;
    }
    if (method === 'POST' && pathname.endsWith('/claim')) {
      json(res, 200, { turn: bridge.claim(binding, body.id) }); return true;
    }
    if (method === 'POST' && pathname.endsWith('/report')) {
      const result = bridge.report(binding, body.id, body.status); await saveState(); json(res, 200, result); return true;
    }
    if (method === 'POST' && pathname.endsWith('/check')) {
      if (body.mediaEpoch !== undefined && (!Number.isSafeInteger(body.mediaEpoch) || body.mediaEpoch < 0)) throw new Error('The call selection is invalid.');
      json(res, 200, { active: bridge.canDispatch(binding, body.callId, body.mediaEpoch) }); return true;
    }
    json(res, 404, { error: 'Browser call action not found.' }); return true;
  } catch (error) { json(res, error.status || 400, { error: error.message }); return true; }
}
