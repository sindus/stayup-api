/**
 * List of available providers, independent of the database engine.
 *
 * A provider exists as soon as it has storage space in the database; its display
 * name comes from the registry, which it populates itself. A provider with no
 * registry entry — not started yet, or no registry at all — falls back to its
 * capitalized name.
 */

import type { DataStore } from './port.js'

export interface Provider {
  name: string
  displayName: string
  /** Display manifest relayed as-is from `provider_registry.template`. */
  template?: unknown
  /** `auto` (flux added immediately) or `manual` (request an admin must approve). */
  flux_approval: 'auto' | 'manual'
  /** Content retention override, in days, set by an admin. Absent = the provider
   *  follows the instance-wide global default (see /ui/maintenance). */
  retention_days?: number
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Providers seen across several databases (primary + secondaries), merged by
 * name: a single "rss" entry even if it exists in several databases. The first
 * occurrence wins, except for `template` — we keep whichever one declares it.
 * Each content row, on the other hand, stays tagged with its own database (see
 * the feed).
 */
export async function listMergedProviders(
  stores: DataStore[],
): Promise<Provider[]> {
  const lists = await Promise.all(stores.map((s) => listProviders(s)))
  const merged = new Map<string, Provider>()
  for (const list of lists) {
    for (const p of list) {
      const cur = merged.get(p.name)
      if (!cur) {
        merged.set(p.name, p)
      } else if (cur.template == null && p.template != null) {
        merged.set(p.name, { ...cur, template: p.template })
      }
    }
  }
  return [...merged.values()]
}

export async function listProviders(store: DataStore): Promise<Provider[]> {
  const names = await store.listProviderNames()
  if (names.length === 0) return []

  const registry = await store.readRegistry(names)
  const meta = new Map(registry.map((r) => [r.name, r]))

  return names
    .map((name) => ({
      name,
      displayName: meta.get(name)?.display_name ?? capitalize(name),
      sortOrder: meta.get(name)?.sort_order ?? 999,
      template: meta.get(name)?.template ?? null,
      flux_approval: meta.get(name)?.flux_approval ?? 'auto',
      retention_days: meta.get(name)?.retention_days,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ name, displayName, template, flux_approval, retention_days }) => {
      // The `template` / `retention_days` keys only show up when they are set:
      // consumers (and tests) that ignore them see the previous shape.
      const p: Provider = { name, displayName, flux_approval }
      if (template != null) p.template = template
      if (retention_days != null) p.retention_days = retention_days
      return p
    })
}
