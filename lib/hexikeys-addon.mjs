// First-party addon orchestration. Secret IPC results are never public resources.
export const HEXIKEYS_ADDON = Object.freeze({
  id: 'hexikeys', name: 'HexiKeys', kind: 'credential-vault', firstParty: true,
  description: 'Your private passwords, keys and PINs. Agents use approved references.'
});

function unavailable() {
  const error = new Error('HexiKeys is unavailable. Open and unlock it, then reconnect.');
  error.code = 'HEXIKEYS_UNAVAILABLE';
  return error;
}

export function createHexiKeysAddon({ withPairing, connect, disconnect, createClient, authorize, recordReceipt = () => {}, onChange = () => {} }) {
  if ([withPairing, connect, disconnect, createClient, authorize].some(value => typeof value !== 'function')) throw new TypeError('HexiKeys requires protected host services.');
  let generation = 0;
  let changing = false;
  const active = new Set();
  const check = async (operation, context, observed = generation) => {
    if (observed !== generation) throw unavailable();
    await authorize(operation, context);
    if (observed !== generation) throw unavailable();
  };
  async function status(context = {}) {
    const observed = generation;
    await check('read', context, observed);
    let result = { ...HEXIKEYS_ADDON, paired: null, available: false, unlocked: false };
    try {
      await withPairing(async pairing => {
        if (!pairing) { result.paired = false; return; }
        result.paired = true;
        const client = createClient(pairing);
        let reply;
        try { reply = await client.status({ signal: context.signal }); }
        finally { await client.close?.(); }
        await check('read', context, observed);
        if (!reply || typeof reply.unlocked !== 'boolean') throw unavailable();
        result.available = true;
        result.unlocked = reply.unlocked;
      });
    } catch (error) {
      // IPC errors, vault diagnostics, grant labels and credentials never escape.
      result.available = false;
      result.unlocked = false;
      if (error?.code === 'HEXKEYS_PAIRING_MISSING') result.paired = false;
    }
    await check('read', context, observed);
    return result;
  }
  async function change(operation, context) {
    await check(operation, context);
    if (changing) throw new Error('HexiKeys connection is changing. Retry when it finishes.');
    changing = true;
    generation += 1;
    onChange();
    const observed = generation;
    for (const controller of active) controller.abort();
    try {
      // connect/disconnect implement their own atomic protected-store update.
      await (operation === 'connect' ? connect : disconnect)(context, () => check(operation, context, observed));
      await check(operation, context, observed);
      recordReceipt({ addon: 'hexikeys', action: operation, status: 'completed' }, context);
    } catch {
      throw new Error('HexiKeys connection could not be updated. Check the protected vault and retry.');
    } finally { changing = false; }
    return status(context);
  }
  async function consume(request, context = {}) {
    // Only a trusted execution adapter may call this; it is not an HTTP resource.
    const observed = generation;
    await check('use', context, observed);
    if (changing || context.signal?.aborted) throw unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    try {
      return await withPairing(async pairing => {
        if (!pairing) throw unavailable();
        await check('use', context, observed);
        if (controller.signal.aborted) throw unavailable();
        const client = createClient(pairing);
        let reply;
        try { reply = await client.consume(request, { signal: controller.signal }); }
        finally { await client.close?.(); }
        await check('use', context, observed);
        if (controller.signal.aborted || typeof reply?.value !== 'string' || !reply.value) throw unavailable();
        recordReceipt({ addon: 'hexikeys', action: 'use', status: 'completed' }, context);
        return { value: reply.value, responseMode: 'metadata-only' };
      });
    } catch { throw unavailable(); }
    finally {
      active.delete(controller);
      context.signal?.removeEventListener('abort', abort);
    }
  }
  async function grant(grantId, context = {}) {
    if (typeof grantId !== 'string' || !/^[0-9a-f]{32}$/.test(grantId)) throw unavailable();
    const observed = generation;
    await check('read', context, observed);
    try {
      return await withPairing(async pairing => {
        if (!pairing) throw unavailable();
        const client = createClient(pairing);
        try {
          let offset = 0;
          for (let page = 0; page < 64; page += 1) {
            const reply = await client.status({ offset, limit: 24, signal: context.signal });
            await check('read', context, observed);
            if (!reply.unlocked) throw unavailable();
            const item = reply.grants.find(item => item.id === grantId);
            if (item) return item;
            if (reply.nextOffset === null) break;
            if (!Number.isInteger(reply.nextOffset) || reply.nextOffset <= offset) throw unavailable();
            offset = reply.nextOffset;
          }
          throw unavailable();
        } finally { await client.close?.(); }
      });
    } catch { throw unavailable(); }
  }
  async function requestCapture(request, context = {}) {
    const observed = generation;
    await check('use', context, observed);
    if (changing || context.signal?.aborted) throw unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    try {
      return await withPairing(async pairing => {
        if (!pairing) throw unavailable();
        await check('use', context, observed);
        if (controller.signal.aborted) throw unavailable();
        const client = createClient(pairing);
        let reply;
        try { reply = await client.requestCapture(request, { signal: controller.signal }); }
        finally { await client.close?.(); }
        await check('use', context, observed);
        if (controller.signal.aborted || reply?.opened !== true) throw unavailable();
        recordReceipt({ addon: 'hexikeys', action: 'capture-request', status: 'completed' }, context);
        return { opened: true };
      });
    } catch { throw unavailable(); }
    finally { active.delete(controller); context.signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({ status, connect: context => change('connect', context || {}), disconnect: context => change('disconnect', context || {}), consume, grant, requestCapture, epoch: () => generation });
}
