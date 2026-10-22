import path from 'node:path';
import { activateLocalRelease, getLocalReleaseStatus, LocalReleaseError, registerLocalRelease, rollbackLocalRelease } from './local-releases.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPABILITY = 'self_modify';
const RISK = 'high';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidBody(body, allowedKeys) {
  if (!isObject(body) || Object.keys(body).some((key) => !allowedKeys.has(key))) return 'Local release request body is malformed.';
  return null;
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

function sendError(json, res, status, message) {
  json(res, status, { error: message });
  return true;
}

function sendPolicyRefusal(json, res, policy) {
  json(res, policy?.denied === true ? 403 : 409, policy);
  return true;
}

function publicFailure(error, json, res, isStatusRequest) {
  if (error instanceof LocalReleaseError) {
    return sendError(json, res, isStatusRequest ? 500 : 409, error.message);
  }
  if (error instanceof SyntaxError) return sendError(json, res, 400, 'Local release request body is malformed.');
  return sendError(json, res, 500, 'The local release request could not be completed.');
}

/**
 * Owner-only release controls. The server must authenticate the owner before
 * dispatching here; this route does not provide signed-execution semantics.
 */
export async function handleLocalReleaseRequest(req, res, ctx) {
  const { pathname, method, readBody, json, connectorPolicy, root, recordReceipt, io, runtimeVersion } = ctx;
  if (method === 'GET' && pathname === '/api/local-releases') {
    let policy;
    try {
      policy = await connectorPolicy('read_local', 'medium', true);
    } catch (error) {
      publicFailure(error, json, res, true);
      return true;
    }
    if (policy) return sendPolicyRefusal(json, res, policy);
    try {
      const status = await getLocalReleaseStatus({ root, io, runtimeVersion });
      json(res, 200, status);
    } catch (error) {
      publicFailure(error, json, res, true);
    }
    return true;
  }

  const actions = {
    '/api/local-releases/register': 'register',
    '/api/local-releases/activate': 'activate',
    '/api/local-releases/rollback': 'rollback'
  };
  const action = method === 'POST' ? actions[pathname] : null;
  if (!action) return false;

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    publicFailure(error, json, res, false);
    return true;
  }
  const allowedKeys = action === 'rollback'
    ? new Set(['confirm', 'approved'])
    : new Set(['id', 'confirm', 'approved']);
  const bodyError = invalidBody(body, allowedKeys);
  if (bodyError) return sendError(json, res, 400, bodyError);
  if (action !== 'rollback' && !validId(body.id)) return sendError(json, res, 400, 'Release id must be a safe opaque identifier.');
  if (body.confirm !== true) return sendError(json, res, 400, 'Local release changes require explicit confirmation.');
  if (typeof body.approved !== 'boolean') return sendError(json, res, 400, 'Local release approval must be a boolean.');

  let policy;
  try {
    policy = await connectorPolicy(CAPABILITY, RISK, body.approved === true);
  } catch (error) {
    publicFailure(error, json, res, false);
    return true;
  }
  if (policy) return sendPolicyRefusal(json, res, policy);
  if (body.approved !== true) return sendError(json, res, 409, 'Local release changes require owner approval.');
  if (typeof recordReceipt !== 'function') return sendError(json, res, 500, 'The local release request could not be completed.');

  try {
    const assertAuthorized = () => {
      if (connectorPolicy(CAPABILITY, RISK, body.approved === true)) throw new LocalReleaseError('Release selection authority changed.');
    };
    await getLocalReleaseStatus({ root, io, runtimeVersion });
    let result;
    if (action === 'register') {
      const source = path.join(root, 'releases', body.id);
      result = await registerLocalRelease({ root, id: body.id, source, io, runtimeVersion, assertAuthorized });
    } else if (action === 'activate') {
      result = await activateLocalRelease({ root, id: body.id, confirm: true, io, runtimeVersion, assertAuthorized });
    } else {
      result = await rollbackLocalRelease({ root, confirm: true, io, runtimeVersion, assertAuthorized });
    }
    await recordReceipt({ action, id: result.id, capability: CAPABILITY, risk: RISK });
    const status = await getLocalReleaseStatus({ root, io, runtimeVersion });
    json(res, 200, { result, status });
  } catch (error) {
    publicFailure(error, json, res, false);
  }
  return true;
}
