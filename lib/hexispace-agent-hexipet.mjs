import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^hxp_[0-9a-f]{64}$/;
const safeText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function callHexiPet(record, credentialVault, rpc, args = {}, fetcher = fetch) {
  const token = await credentialVault.get(record.vaultRef);
  if (!TOKEN.test(String(token || ''))) {
    throw new Error('This Hexonaut profile connection was revoked or its protected credential is unavailable.');
  }
  const response = await fetcher(`${record.supabaseUrl}/rest/v1/rpc/${rpc}`, {
    method: 'POST',
    headers: {
      apikey: record.anonKey,
      ...(record.anonKey.startsWith('sb_publishable_') ? {} : { Authorization: `Bearer ${record.anonKey}` }),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ p_token: token, ...args }),
    signal: AbortSignal.timeout(15_000)
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'Hexonaut profile access was denied or revoked.'
      : 'HexiSpace could not complete this Hexipet profile action.');
  }
  if (raw.length > 512 * 1024) throw new Error('HexiSpace returned an oversized Hexipet response; access was stopped.');
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error('HexiSpace returned an invalid Hexipet response.'); }
  if (!isObject(result) || result.profileId !== record.profileId) {
    throw new Error('HexiSpace returned a different Hexonaut profile; access was stopped.');
  }
  return result;
}

function safeInventoryItem(item) {
  if (!isObject(item) || !UUID.test(String(item.instanceId || ''))
      || !Number.isInteger(item.dexNumber) || typeof item.displayName !== 'string') {
    throw new Error('HexiSpace returned an invalid Hexipet inventory item; access was stopped.');
  }
  return {
    instanceId: item.instanceId,
    dexNumber: item.dexNumber,
    displayName: safeText(item.displayName, 80),
    description: safeText(item.description, 500),
    category: safeText(item.category, 40),
    rarity: safeText(item.rarity, 40),
    sourceEvent: safeText(item.sourceEvent, 100)
  };
}

function safeAccessory(item) {
  if (item === null) return null;
  if (!isObject(item) || !UUID.test(String(item.instanceId || ''))
      || typeof item.accessoryKey !== 'string' || !['hat', 'trail'].includes(item.slot)
      || !Number.isSafeInteger(item.coinPrice) || item.coinPrice < 0 || typeof item.acquiredAt !== 'string') {
    throw new Error('HexiSpace returned an invalid Hexipet accessory; access was stopped.');
  }
  return {
    instanceId: item.instanceId,
    accessoryKey: safeText(item.accessoryKey, 80),
    displayName: safeText(item.displayName, 80),
    slot: item.slot,
    description: safeText(item.description, 500),
    coinPrice: Number.isSafeInteger(item.coinPrice) && item.coinPrice >= 0 ? item.coinPrice : 0,
    acquiredAt: safeText(item.acquiredAt, 40)
  };
}

function safeOutfitAccessory(item) {
  if (item === null) return null;
  if (!isObject(item) || !UUID.test(String(item.instanceId || ''))
      || typeof item.accessoryKey !== 'string' || !['hat', 'trail'].includes(item.slot)) {
    throw new Error('HexiSpace returned an invalid Hexipet outfit accessory; access was stopped.');
  }
  return { instanceId: item.instanceId, accessoryKey: safeText(item.accessoryKey, 80),
    displayName: safeText(item.displayName, 80), slot: item.slot };
}

export async function listLinkedHexonautHexipets(record, credentialVault, fetcher = fetch) {
  const result = await callHexiPet(record, credentialVault, 'agent_list_own_hexipets', {}, fetcher);
  if (!Array.isArray(result.inventory) || result.inventory.length > 1000
      || !Array.isArray(result.accessories) || result.accessories.length > 1000) {
    throw new Error('HexiSpace returned an invalid Hexipet collection; access was stopped.');
  }
  let equippedPet = null;
  if (result.equippedPet !== null) {
    if (!isObject(result.equippedPet) || !UUID.test(String(result.equippedPet.instanceId || ''))
        || !Number.isInteger(result.equippedPet.dexNumber) || typeof result.equippedPet.displayName !== 'string') {
      throw new Error('HexiSpace returned an invalid equipped Hexipet; access was stopped.');
    }
    equippedPet = { instanceId: result.equippedPet.instanceId, dexNumber: result.equippedPet.dexNumber,
      displayName: safeText(result.equippedPet.displayName, 80) };
  }
  let activeOutfit = null;
  if (result.activeOutfit !== null && result.activeOutfit !== undefined) {
    if (!isObject(result.activeOutfit) || !UUID.test(String(result.activeOutfit.petInstanceId || ''))) {
      throw new Error('HexiSpace returned an invalid Hexipet outfit; access was stopped.');
    }
    activeOutfit = { petInstanceId: result.activeOutfit.petInstanceId,
      hat: safeOutfitAccessory(result.activeOutfit.hat ?? null), trail: safeOutfitAccessory(result.activeOutfit.trail ?? null) };
  }
  return {
    profileId: record.profileId,
    inventory: result.inventory.map(safeInventoryItem),
    equippedPet,
    accessories: result.accessories.map(safeAccessory),
    activeOutfit
  };
}

export async function equipLinkedHexonautHexipet(record, input, credentialVault, fetcher = fetch) {
  const instanceId = input?.instanceId;
  if (!isObject(input) || Object.keys(input).some((key) => !['instanceId'].includes(key)) || !UUID.test(String(instanceId || ''))) {
    throw new Error('Choose one Hexipet instance from this account’s inventory.');
  }
  const result = await callHexiPet(record, credentialVault, 'agent_equip_own_hexipet', { p_instance_id: instanceId }, fetcher);
  if (result.instanceId !== instanceId || result.equipped !== true || typeof result.petKey !== 'string') {
    throw new Error('HexiSpace did not confirm equipping that Hexipet on this profile.');
  }
  return { profileId: record.profileId, instanceId, petKey: safeText(result.petKey, 100), equipped: true };
}

export async function unequipLinkedHexonautHexipet(record, input, credentialVault, fetcher = fetch) {
  if (!isObject(input) || Object.keys(input).length !== 0) throw new Error('Unequip accepts no additional profile or inventory fields.');
  const result = await callHexiPet(record, credentialVault, 'agent_unequip_own_hexipet', {}, fetcher);
  if (result.instanceId !== null || result.equipped !== false) {
    throw new Error('HexiSpace did not confirm removing this profile’s equipped Hexipet.');
  }
  return { profileId: record.profileId, instanceId: null, equipped: false };
}

export async function setLinkedHexonautHexipetOutfit(record, input, credentialVault, fetcher = fetch) {
  const allowed = ['hatAccessoryId', 'trailAccessoryId'];
  if (!isObject(input) || Object.keys(input).some((key) => !allowed.includes(key))
      || allowed.some((key) => !(key in input))
      || allowed.some((key) => input[key] !== null && !UUID.test(String(input[key])))) {
    throw new Error('Select an owned hat and trail accessory, using null to clear either slot.');
  }
  const result = await callHexiPet(record, credentialVault, 'agent_set_own_hexipet_outfit', {
    p_hat_accessory_id: input.hatAccessoryId,
    p_trail_accessory_id: input.trailAccessoryId
  }, fetcher);
  if (!UUID.test(String(result.petInstanceId || ''))
      || result.hatAccessoryId !== input.hatAccessoryId || result.trailAccessoryId !== input.trailAccessoryId
      || typeof result.changed !== 'boolean') {
    throw new Error('HexiSpace did not confirm the requested Hexipet outfit on this profile.');
  }
  return { profileId: record.profileId, petInstanceId: result.petInstanceId,
    hatAccessoryId: result.hatAccessoryId, trailAccessoryId: result.trailAccessoryId, changed: result.changed };
}
