import { createHash, randomBytes } from 'node:crypto';

const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const GRANT = /^[0-9a-f]{32}$/;
const queues = new WeakMap();
function invalid() { return new Error('Choose an exact declared plugin credential and capability.'); }
function scopeIdentity(plugin, capability, secretId, actor) {
  if (!ID.test(plugin?.id) || !ID.test(capability?.id) || !ID.test(secretId) || !plugin.secrets?.some(s => s.id === secretId)
    || !plugin.capabilities?.includes(capability) || typeof actor !== 'string' || !actor || actor.length > 200) throw invalid();
  const digest = createHash('sha256').update(JSON.stringify([plugin.id, capability.id, secretId, actor])).digest('hex');
  return { key: digest, taskId: `plugin-${digest.slice(0, 48)}` };
}
export function hexikeysPluginRecipe(plugin, capability, secretId, actor, ruleIndex = 0) {
  const identity = scopeIdentity(plugin, capability, secretId, actor);
  if (!Number.isInteger(ruleIndex) || ruleIndex < 0) throw invalid();
  const rule = capability.permissions?.network?.[ruleIndex];
  const mapping = rule?.secretHeaders?.find(item => item.secret === secretId);
  if (!mapping || !rule.origin.startsWith('https://')) throw new Error('HexiKeys requires a declared HTTPS credential destination.');
  if (!/^(?:authorization|x-[a-z0-9-]{1,80})$/.test(mapping.header) || mapping.prefix.length > 64) throw new Error('HexiKeys supports Authorization and X- credential headers with prefixes up to 64 characters.');
  return Object.freeze({ version: 1, connectorId: plugin.id, capabilityId: capability.id, taskId: identity.taskId,
    origin: rule.origin, pathPrefix: rule.pathPrefix, methods: [...rule.methods], header: mapping.header, prefix: mapping.prefix });
}
async function serial(vault, callback) {
  const previous = queues.get(vault) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  queues.set(vault, current);
  await previous;
  try { return await callback(); } finally { release(); if (queues.get(vault) === current) queues.delete(vault); }
}
function storageId(plugin) { if (!ID.test(plugin?.id)) throw invalid(); return `hexikeys-plugin-${plugin.id}`; }
async function read(vault, plugin) {
  const raw = await vault.get(storageId(plugin));
  if (!raw) return {};
  try {
    if (raw.length > 256000) throw invalid();
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 1000 ||
      Object.entries(value).some(([key, record]) => !/^[0-9a-f]{64}$/.test(key) ||
        !record || Object.keys(record).length !== 1 || !GRANT.test(record.grantId))) throw invalid();
    return value;
  } catch { throw new Error('Protected HexiKeys references are unavailable. Reconnect the intended reference.'); }
}
export function createHexiKeysPluginBindings({ vault, consume, authorize }) {
  async function get(plugin, capability, secretId, actor) {
    const identity = scopeIdentity(plugin, capability, secretId, actor);
    return serial(vault, async () => (await read(vault, plugin))[identity.key] || null);
  }
  async function set({ plugin, capability, secretId, actor, grantId, context }) {
    const identity = scopeIdentity(plugin, capability, secretId, actor);
    if (grantId !== null && (typeof grantId !== 'string' || !GRANT.test(grantId))) throw new Error('Use an opaque HexiKeys reference, never a credential value.');
    return serial(vault, async () => {
      await authorize(context);
      const previous = await vault.get(storageId(plugin));
      const records = await read(vault, plugin);
      if (grantId === null) delete records[identity.key]; else records[identity.key] = { grantId };
      if (Object.keys(records).length > 1000) throw new Error('Remove unused HexiKeys references before adding another.');
      await authorize(context);
      const serialized = JSON.stringify(records);
      await vault.set(storageId(plugin), serialized);
      try { await authorize(context); }
      catch (error) {
        if (previous) await vault.set(storageId(plugin), previous); else await vault.remove(storageId(plugin), { requireAvailable: true });
        throw error;
      }
      return { configured: grantId !== null };
    });
  }
  async function resolve({ plugin, capability, secretId, actor, request, context }) {
    const identity = scopeIdentity(plugin, capability, secretId, actor);
    const binding = await get(plugin, capability, secretId, actor);
    if (!binding) return null; // Compatibility: caller may use an existing static OS-vault credential.
    await authorize(context);
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || request.capabilityId !== capability.id) throw invalid();
    context.onReferenceUse?.();
    // Request identity and destination come from the host broker, never plugin input IDs.
    return consume({ grantId: binding.grantId, requestId: randomBytes(16).toString('hex'), connectorId: plugin.id,
      capabilityId: capability.id, taskId: identity.taskId, origin: url.origin, path: url.pathname,
      method: request.method, header: request.header, prefix: request.prefix }, { ...context, signal: request.signal });
  }
  async function removePlugin(plugin, context) {
    return serial(vault, async () => {
      // Plugins without a HexiKeys binding keep their existing removal policy.
      if (!await vault.get(storageId(plugin))) return;
      await authorize(context);
      await vault.remove(storageId(plugin), { requireAvailable: true });
    });
  }
  return Object.freeze({ get, set, resolve, removePlugin });
}
