import { OWNER_MEMORY_STATUSES } from './owner-memory.mjs';
import { normalizeContextScope } from './dated-memory.mjs';

const MAX_FACET_VALUES = 128;
const MISTAKE_ID = /^mistake-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function isCanonicalMemoryMistake(record) {
  const wrapper = record?.metadata?.memoryMistake;
  const mistake = wrapper?.record;
  if (!wrapper || wrapper.format !== 'hexigrid-memory-mistake' || wrapper.version !== 1 ||
    !mistake || typeof mistake !== 'object' || Array.isArray(mistake) ||
    mistake.format !== 'hexigrid-memory-mistake' || mistake.version !== 1 ||
    typeof mistake.id !== 'string' || typeof mistake.agentId !== 'string' || typeof mistake.lineageId !== 'string' ||
    typeof record?.id !== 'string' || typeof record.agentId !== 'string' || typeof record.lineageId !== 'string') return false;
  const idMatch = mistake.id.match(MISTAKE_ID);
  if (!idMatch || record.id.toLowerCase() !== `memory-${idMatch[1]}`.toLowerCase() ||
    record.agentId !== mistake.agentId || record.lineageId.toLowerCase() !== mistake.lineageId.toLowerCase()) return false;
  try {
    return JSON.stringify(normalizeContextScope(record.contextScope ?? null)) ===
      JSON.stringify(normalizeContextScope(mistake.contextScope ?? null));
  } catch { return false; }
}

function normalizeScopeFilter(value) {
  if (typeof value !== 'string') throw new Error('Fact scope filter must be a string.');
  if (value === '') return null;
  if (value === '__unscoped__') return { unscoped: true, value, label: 'Unscoped' };
  if (Buffer.byteLength(value, 'utf8') > 512) throw new Error('Fact scope filter is too large.');

  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('Fact scope filter is invalid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'projectId') || !Object.hasOwn(parsed, 'topicId') ||
    typeof parsed.projectId !== 'string' || typeof parsed.topicId !== 'string') {
    throw new Error('Fact scope filter is invalid.');
  }

  let normalized;
  try {
    normalized = normalizeContextScope(parsed.topicId === '' ? { projectId: parsed.projectId } : parsed);
  } catch {
    throw new Error('Fact scope filter is invalid.');
  }
  const scope = { projectId: normalized.projectId, topicId: normalized.topicId || '' };
  const canonical = JSON.stringify(scope);
  if (value !== canonical) throw new Error('Fact scope filter must use canonical JSON.');
  return { unscoped: false, value: canonical, scope: normalized,
    label: [scope.projectId, scope.topicId].filter(Boolean).join(' / ') };
}

function scopeFacet(record) {
  if (!record.contextScope) return { value: '__unscoped__', label: 'Unscoped' };
  const scope = normalizeContextScope(record.contextScope);
  const value = JSON.stringify({ projectId: scope.projectId, topicId: scope.topicId || '' });
  return { value, label: [scope.projectId, scope.topicId].filter(Boolean).join(' / ') };
}

function boundedFacetValues(values, selectedValue = '') {
  const unique = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  let bounded = unique.slice(0, MAX_FACET_VALUES);
  if (selectedValue && !bounded.includes(selectedValue)) {
    bounded = [...unique.slice(0, MAX_FACET_VALUES - 1), selectedValue];
    bounded.sort((left, right) => left.localeCompare(right));
  }
  return { values: bounded, truncated: unique.some(value => !bounded.includes(value)) };
}

function matchesScope(record, selected) {
  if (!selected) return true;
  if (selected.unscoped) return record.contextScope === null || record.contextScope === undefined;
  const actual = record.contextScope;
  return Boolean(actual) && actual.projectId === selected.scope.projectId &&
    (actual.topicId || '') === (selected.scope.topicId || '');
}

function categoryLabel(value) {
  if (typeof value !== 'string') return 'General';
  const label = value.trim();
  return label && Buffer.byteLength(label, 'utf8') <= 160 ? label : 'General';
}

/** Owner browsing uses the exact lineage and local text matching, without model calls. */
export async function pageMemoryFacts(store, { lineageId, query = '', kind = 'all', standing = 'current', depth = 0, limit = 30, after = null, category = '', scope = '' } = {}) {
  if (typeof query !== 'string' || query.length > 500) throw new Error('Fact search must be at most 500 characters.');
  if (!['all', 'mistakes'].includes(kind)) throw new Error('Fact kind is invalid.');
  if (typeof category !== 'string' || Buffer.byteLength(category, 'utf8') > 160) throw new Error('Fact category filter must be a string of at most 160 bytes.');
  const selectedScope = normalizeScopeFilter(scope);
  if (!['current', 'all', ...OWNER_MEMORY_STATUSES].includes(standing)) throw new Error('Fact standing is invalid.');
  if (![0, 1, 2].includes(depth)) throw new Error('Fact detail must be 0, 1, or 2.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Fact page size must be 1 to 100.');
  if (after !== null && !/^memory-[0-9a-f-]{36}$/.test(after)) throw new Error('Fact cursor is invalid.');
  const text = query.trim().toLocaleLowerCase();
  const allRecords = await store.readRange({ lineageId, from: '0001-01-01', to: '9999-12-31', depth });
  const disputedCount = allRecords.filter(record => record.status === 'disputed').length;
  const kindRecords = kind === 'mistakes' ? allRecords.filter(isCanonicalMemoryMistake) : allRecords;
  const standingAndQueryRecords = kindRecords
    .filter((record) => standing === 'all' || (standing === 'current' ? ['active', 'conditional'].includes(record.status) : record.status === standing))
    .filter((record) => !text || [record.text, record.id, record.valid_while, record.contextScope?.projectId, record.contextScope?.topicId].some((value) => String(value || '').toLocaleLowerCase().includes(text)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const categoriesFacet = boundedFacetValues(standingAndQueryRecords.map(record => categoryLabel(record.metadata?.category)), category);
  const scopesByValue = new Map(standingAndQueryRecords.map(record => {
    const facet = scopeFacet(record);
    return [facet.value, facet];
  }));
  const scopesFacet = boundedFacetValues([...scopesByValue.keys()], selectedScope?.value || '');
  if (selectedScope && !scopesByValue.has(selectedScope.value)) {
    scopesByValue.set(selectedScope.value, { value: selectedScope.value, label: selectedScope.label });
  }
  const facets = {
    categories: categoriesFacet.values,
    scopes: scopesFacet.values.map(value => scopesByValue.get(value)),
    truncated: { categories: categoriesFacet.truncated, scopes: scopesFacet.truncated }
  };
  const records = standingAndQueryRecords
    .filter(record => !category || categoryLabel(record.metadata?.category) === category)
    .filter(record => matchesScope(record, selectedScope));
  const start = after === null ? 0 : records.findIndex((record) => record.id === after) + 1;
  if (after !== null && start === 0) { const error = new Error('This fact page changed. Refresh to begin again.'); error.status = 409; throw error; }
  const page = records.slice(start, start + limit);
  const hasMore = start + page.length < records.length;
  return { facts: page, total: records.length, hasMore, nextCursor: hasMore ? page.at(-1).id : null,
    matchMethod: 'local-text', facets, disputedCount };
}
