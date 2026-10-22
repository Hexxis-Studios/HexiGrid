import crypto from 'node:crypto';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ENTITY_ID = new RegExp(`^entity-${UUID}$`);
const EVENT_ID = new RegExp(`^entity-event-${UUID}$`);
const MEMORY_ID = new RegExp(`^memory-${UUID}$`);
const LINEAGE_ID = new RegExp(`^lineage-${UUID}$`);
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIONS = new Set(['propose', 'create', 'confirm', 'reject', 'merge', 'alias-add', 'alias-remove', 'links']);
const ENTITY_TYPES = new Set(['person', 'project']);
const MAX_ALIASES = 32;
const MAX_CANDIDATES = 8;
const MAX_LINKS = 32;
const WORD = /[\p{L}\p{M}\p{N}]/u;
const NAME = /[\p{Lu}][\p{L}\p{M}'’.-]{1,63}(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]{1,63}){1,2}/gu;
const PROJECT = /\b[Pp]roject\s+([\p{Lu}][\p{L}\p{M}\p{N}'’.-]{1,63}(?:\s+[\p{Lu}][\p{L}\p{M}\p{N}'’.-]{1,63}){0,2})/gu;
const NAME_STOP = new Set(['The', 'This', 'That', 'When', 'Where', 'What', 'Today', 'Tomorrow', 'Yesterday', 'Project']);

const own = (value, key) => Object.hasOwn(value, key);
const timestamp = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error('Entity event timestamp is invalid.');
  return date.toISOString();
};

export function entityAliasKey(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function normalizeEntityLabel(value) {
  const label = String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!label || Buffer.byteLength(label, 'utf8') > 160 || /[\p{C}]/u.test(label) || !/[\p{L}\p{N}]/u.test(label)) {
    throw new Error('Entity label must be bounded plain text.');
  }
  return label;
}

function normalizeEntityType(value) {
  if (!ENTITY_TYPES.has(value)) throw new Error('Entity type must be person or project.');
  return value;
}

function normalizeProject(value) {
  if (value === null || value === undefined) return null;
  if (!PROJECT_ID.test(String(value))) throw new Error('Entity project scope is invalid.');
  return String(value);
}

function normalizeAliases(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ALIASES) throw new Error('Entity aliases are invalid.');
  const aliases = [label, ...value.map(normalizeEntityLabel)];
  const unique = new Map(aliases.map((alias) => [entityAliasKey(alias), alias]));
  if (unique.size !== aliases.length) throw new Error('Entity aliases must be distinct.');
  return aliases;
}

function id(value, pattern, label) {
  const result = String(value ?? '').toLowerCase();
  if (!pattern.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Entity revision is invalid.');
  return value;
}

function owner(value) {
  const by = String(value ?? '').trim();
  if (!/^owner:[A-Za-z0-9._:-]{1,160}$/.test(by)) throw new Error('Entity change requires an authenticated owner.');
  return by;
}

function reason(value) {
  const why = String(value ?? '').trim();
  if (!why || Buffer.byteLength(why, 'utf8') > 4096) throw new Error('Entity change requires a bounded reason.');
  return why;
}

export function normalizeEntityEvent(input, { lineageId, date, now } = {}) {
  if (!input || input.kind !== 'entity' || !ACTIONS.has(input.action)) throw new Error('Entity event action is invalid.');
  const createdAt = timestamp(input.createdAt ?? now);
  if (createdAt.slice(0, 10) !== date) throw new Error('Entity event date does not match its log.');
  const event = {
    kind: 'entity', action: input.action,
    eventId: id(input.eventId, EVENT_ID, 'Entity event ID'),
    lineageId: id(lineageId, LINEAGE_ID, 'Entity lineage ID'),
    date, createdAt
  };
  if (input.action === 'links') {
    event.memoryId = id(input.memoryId, MEMORY_ID, 'Entity memory ID');
    event.memoryRevision = revision(input.memoryRevision);
    if (!Array.isArray(input.entityIds) || input.entityIds.length > MAX_LINKS) throw new Error('Entity links are invalid.');
    event.entityIds = input.entityIds.map((value) => id(value, ENTITY_ID, 'Entity ID'));
    if (new Set(event.entityIds).size !== event.entityIds.length) throw new Error('Entity links are duplicated.');
  } else {
    event.entityId = id(input.entityId, ENTITY_ID, 'Entity ID');
    if (input.action === 'propose' || input.action === 'create') {
      event.label = normalizeEntityLabel(input.label);
      event.entityType = normalizeEntityType(input.entityType);
      event.projectId = normalizeProject(input.projectId);
      if (input.action === 'propose') {
        event.sourceMemoryId = id(input.sourceMemoryId, MEMORY_ID, 'Entity source memory ID');
        event.sourceRevision = revision(input.sourceRevision);
      } else {
        event.by = owner(input.by);
        event.why = reason(input.why);
        event.aliases = normalizeAliases(input.aliases ?? [], event.label).slice(1);
      }
    } else {
      event.expectedRevision = revision(input.expectedRevision);
      event.by = owner(input.by);
      event.why = reason(input.why);
      if (input.action === 'confirm') {
        event.label = normalizeEntityLabel(input.label);
        event.entityType = normalizeEntityType(input.entityType);
        event.aliases = normalizeAliases(input.aliases ?? [], event.label).slice(1);
      } else if (input.action === 'merge') {
        event.targetEntityId = id(input.targetEntityId, ENTITY_ID, 'Entity target ID');
        event.alias = normalizeEntityLabel(input.alias);
      } else if (input.action === 'alias-add' || input.action === 'alias-remove') {
        event.alias = normalizeEntityLabel(input.alias);
      }
    }
  }
  if (input.audit !== undefined) event.audit = input.audit;
  return event;
}

function aliasesOf(entity) { return [entity.label, ...entity.aliases]; }
function scopesOverlap(left, right) { return !left || !right || left === right; }

function assertAliasVacant(entities, entityId, aliases, projectId) {
  const wanted = new Set(aliases.map(entityAliasKey));
  for (const other of entities.values()) {
    if (other.id === entityId || other.status !== 'confirmed' || !scopesOverlap(other.projectId, projectId)) continue;
    if (aliasesOf(other).some((alias) => wanted.has(entityAliasKey(alias)))) throw new Error('Entity alias collides with another confirmed entity.');
  }
}

export function materializeEntityRegistry(events = []) {
  const entities = new Map();
  const links = new Map();
  const memoryRevisions = new Map();
  const eventIds = new Set();
  for (const event of events) {
    if (event.kind !== 'entity') {
      if (event.kind === 'revision') {
        if (memoryRevisions.has(event.id)) memoryRevisions.set(event.id, memoryRevisions.get(event.id) + 1);
      } else if (event.kind !== 'evaluation' && MEMORY_ID.test(String(event.id ?? ''))) memoryRevisions.set(event.id, 0);
      continue;
    }
    if (eventIds.has(event.eventId)) throw new Error('Entity event ID was reused.');
    eventIds.add(event.eventId);
    if (event.action === 'links') {
      if (memoryRevisions.get(event.memoryId) !== event.memoryRevision) throw new Error('Entity links target a missing memory revision.');
      if (event.entityIds.some((entityId) => !entities.has(entityId) || entities.get(entityId).status === 'rejected')) throw new Error('Entity links target an unavailable entity.');
      links.set(event.memoryId, [...event.entityIds]);
      continue;
    }
    if (event.action === 'propose' || event.action === 'create') {
      if (entities.has(event.entityId) || (event.action === 'propose' && (!memoryRevisions.has(event.sourceMemoryId) || memoryRevisions.get(event.sourceMemoryId) < event.sourceRevision))) {
        throw new Error('Pending entity source or ID is invalid.');
      }
      if (event.action === 'create') assertAliasVacant(entities, event.entityId, [event.label, ...event.aliases], event.projectId);
      entities.set(event.entityId, { id: event.entityId, label: event.label, entityType: event.entityType,
        projectId: event.projectId, aliases: event.action === 'create' ? [...event.aliases] : [],
        status: event.action === 'create' ? 'confirmed' : 'pending', revision: 0,
        ...(event.action === 'propose' ? { sourceMemoryId: event.sourceMemoryId, sourceRevision: event.sourceRevision } : {}),
        createdAt: event.createdAt });
      continue;
    }
    const entity = entities.get(event.entityId);
    if (!entity || entity.revision !== event.expectedRevision) throw new Error('Entity revision conflict.');
    if (event.action === 'confirm') {
      if (entity.status !== 'pending') throw new Error('Only a pending entity can be confirmed.');
      assertAliasVacant(entities, entity.id, [event.label, ...event.aliases], entity.projectId);
      entity.label = event.label; entity.entityType = event.entityType; entity.aliases = [...event.aliases]; entity.status = 'confirmed';
    } else if (event.action === 'reject') {
      if (entity.status !== 'pending') throw new Error('Only a pending entity can be rejected.');
      entity.status = 'rejected';
    } else if (event.action === 'merge') {
      const target = entities.get(event.targetEntityId);
      if (entity.status !== 'pending' || !target || target.status !== 'confirmed' ||
        (target.projectId && entity.projectId !== target.projectId)) throw new Error('Pending entity merge is invalid.');
      assertAliasVacant(entities, target.id, [event.alias], target.projectId);
      if (!aliasesOf(target).some((alias) => entityAliasKey(alias) === entityAliasKey(event.alias))) {
        if (target.aliases.length >= MAX_ALIASES) throw new Error('Entity alias limit reached.');
        target.aliases.push(event.alias);
        target.revision += 1;
      }
      entity.status = 'merged'; entity.targetEntityId = target.id;
    } else if (event.action === 'alias-add') {
      if (entity.status !== 'confirmed' || aliasesOf(entity).some((alias) => entityAliasKey(alias) === entityAliasKey(event.alias))) throw new Error('Entity alias already exists or entity is unconfirmed.');
      if (entity.aliases.length >= MAX_ALIASES) throw new Error('Entity alias limit reached.');
      assertAliasVacant(entities, entity.id, [event.alias], entity.projectId);
      entity.aliases.push(event.alias);
    } else if (event.action === 'alias-remove') {
      if (entity.status !== 'confirmed' || entityAliasKey(entity.label) === entityAliasKey(event.alias)) throw new Error('The canonical entity label cannot be removed.');
      const index = entity.aliases.findIndex((alias) => entityAliasKey(alias) === entityAliasKey(event.alias));
      if (index < 0) throw new Error('Entity alias was not found.');
      entity.aliases.splice(index, 1);
    }
    entity.revision += 1;
    entity.updatedAt = event.createdAt;
  }
  return { entities, links };
}

function containsAlias(textKey, aliasKey) {
  let at = textKey.indexOf(aliasKey);
  while (at >= 0) {
    const before = at === 0 ? '' : textKey[at - 1];
    const after = textKey[at + aliasKey.length] ?? '';
    if ((!before || !WORD.test(before)) && (!after || !WORD.test(after))) return true;
    at = textKey.indexOf(aliasKey, at + 1);
  }
  return false;
}

function linkableText(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/gu, ' ')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/(?:"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’)/gu, ' ');
}

export function matchConfirmedEntities(registry, text, { projectId = null } = {}) {
  const textKey = entityAliasKey(linkableText(text));
  const matched = [];
  for (const entity of registry.entities.values()) {
    if (entity.status !== 'confirmed' || (entity.projectId && entity.projectId !== projectId)) continue;
    if (aliasesOf(entity).some((alias) => containsAlias(textKey, entityAliasKey(alias)))) matched.push(entity.id);
  }
  return matched.sort();
}

export function pendingEntityCandidates(registry, text, { projectId = null } = {}) {
  const candidates = new Map();
  const add = (label, entityType) => {
    const normalized = normalizeEntityLabel(label);
    const key = entityAliasKey(normalized);
    if (candidates.has(key) || candidates.size >= MAX_CANDIDATES) return;
    if (matchConfirmedEntities(registry, normalized, { projectId }).length) return;
    if ([...registry.entities.values()].some((entity) =>
      (!entity.projectId || entity.projectId === projectId) &&
      (entity.status === 'pending' && entityAliasKey(entity.label) === key ||
       entity.status === 'confirmed' && aliasesOf(entity).some((alias) => entityAliasKey(alias) === key)))) return;
    candidates.set(key, { label: normalized, entityType, projectId });
  };
  const source = linkableText(text);
  for (const match of source.matchAll(PROJECT)) add(`Project ${match[1]}`, 'project');
  for (const match of source.matchAll(NAME)) {
    const words = match[0].split(/\s+/u);
    if (NAME_STOP.has(words[0]) || /^Project\s/u.test(match[0])) continue;
    add(match[0], 'person');
  }
  return [...candidates.values()];
}

export function matchPendingEntities(registry, text, { projectId = null } = {}) {
  const textKey = entityAliasKey(linkableText(text));
  return [...registry.entities.values()].filter((entity) => entity.status === 'pending' &&
    (!entity.projectId || entity.projectId === projectId) && containsAlias(textKey, entityAliasKey(entity.label)))
    .map((entity) => entity.id).sort();
}

export function newEntityId() { return `entity-${crypto.randomUUID()}`; }
export function newEntityEventId() { return `entity-event-${crypto.randomUUID()}`; }
