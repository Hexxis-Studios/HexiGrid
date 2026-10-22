const DAY = 86_400_000;
// Local ranking defaults, not deletion rules. Unknown categories preserve the
// existing behavior. A deadline or TTL never silently changes a record's status.
export const MEMORY_CATEGORY_RULES = Object.freeze({
  temporary: Object.freeze({ ttlDays: 7, halfLifeDays: 7 }),
  project: Object.freeze({ ttlDays: 90, halfLifeDays: 90 }),
  preference: Object.freeze({ ttlDays: 365, halfLifeDays: 365 }),
  correction: Object.freeze({ ttlDays: 365, halfLifeDays: 365 })
});

export function memoryStaleness(record, nowMs) {
  const clock = Number.isFinite(nowMs) ? nowMs : Date.now();
  const timestamp = Date.parse(record?.updatedAt || record?.createdAt || record?.date || '');
  const ageDays = Number.isFinite(timestamp) ? Math.max(0, (clock - timestamp) / DAY) : 365;
  const category = record?.metadata?.category;
  const rule = typeof category === 'string' && Object.hasOwn(MEMORY_CATEGORY_RULES, category)
    ? MEMORY_CATEGORY_RULES[category] : null;
  const value = record?.verify_by;
  const explicit = value ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? `${value}T23:59:59.999Z` : String(value)) : null;
  const explicitDeadline = explicit === null ? null : Number.isFinite(explicit) ? explicit : -Infinity;
  const categoryDeadline = rule && Number.isFinite(timestamp) ? timestamp + rule.ttlDays * DAY : null;
  const deadlines = [explicitDeadline, categoryDeadline].filter(value => value !== null);
  const deadline = deadlines.length ? Math.min(...deadlines) : null;
  const stale = deadline !== null && clock > deadline;
  const staleDays = stale ? Math.max(0, (clock - deadline) / DAY) : 0;
  return {
    category: rule ? category : null,
    deadline,
    stale,
    recency: rule ? Math.exp(-Math.LN2 * ageDays / rule.halfLifeDays) : Math.pow(0.995, ageDays),
    penalty: stale ? Math.max(0.1, 0.35 * Math.exp(-staleDays / 180)) : 1
  };
}
