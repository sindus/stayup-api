/**
 * On existing Postgres databases, `repository.config` carried a double-
 * serialization bug (see `repairConfig` in postgres.ts): a config once stored
 * as a JSON string, then merged with the `||` operator against an object, does
 * not produce a merged object — `||` only merges two objects key by key; given
 * a scalar (a string) and an object, it wraps the scalar in a one-element array
 * and concatenates. The result seen in production:
 * `["{\"max_scraps\":5}", {"title": "…"}]` instead of
 * `{"max_scraps": 5, "title": "…"}`.
 *
 * This function rebuilds a flat object from any of those degraded shapes
 * (object, array, JSON string, or empty), without losing the keys they still
 * carry — used by `mergeSourceConfig` on all 4 adapters to merge without ever
 * compounding the corruption, and to repair it along the way the next time a
 * connector touches the row.
 */
export function normalizeConfigObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {}
  if (Array.isArray(raw)) {
    const merged: Record<string, unknown> = {}
    for (const item of raw) Object.assign(merged, normalizeConfigObject(item))
    return merged
  }
  if (typeof raw === 'string') {
    try {
      return normalizeConfigObject(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}
