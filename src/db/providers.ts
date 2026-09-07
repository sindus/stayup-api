/**
 * Liste des providers disponibles, indépendamment du moteur de base.
 *
 * Un provider existe dès qu'il a un espace de stockage dans la base ; son nom
 * affiché vient du registre, qu'il alimente lui-même. Un provider sans entrée de
 * registre — pas encore démarré, ou registre absent — retombe sur son nom capitalisé.
 */

import type { DataStore } from './port.js'

export interface Provider {
  name: string
  displayName: string
  /** Manifeste d'affichage relayé tel quel depuis `provider_registry.template`. */
  template?: unknown
  /** `auto` (ajout de flux immédiat) ou `manual` (demande à valider par un admin). */
  flux_approval: 'auto' | 'manual'
  /** Surcharge de rétention du contenu, en jours, posée par un admin. Absent =
   *  le provider suit le défaut global de l'instance (voir /ui/maintenance). */
  retention_days?: number
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Providers vus par plusieurs bases (principale + secondaires), fusionnés par
 * nom : une seule entrée « rss » même s'il existe dans plusieurs bases. La
 * première occurrence gagne, sauf pour `template` — on garde celui qui en
 * déclare un. Chaque ligne de contenu, elle, reste taguée par sa base (voir le
 * feed).
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
      // Les clés `template` / `retention_days` n'apparaissent que si elles sont
      // posées : les consommateurs (et les tests) qui les ignorent voient la
      // forme d'avant.
      const p: Provider = { name, displayName, flux_approval }
      if (template != null) p.template = template
      if (retention_days != null) p.retention_days = retention_days
      return p
    })
}
