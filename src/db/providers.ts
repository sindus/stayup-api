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
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
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
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ name, displayName, template, flux_approval }) =>
      // La clé `template` n'apparaît que si le provider en déclare un : les
      // consommateurs (et les tests) qui l'ignorent voient la forme d'avant.
      template == null
        ? { name, displayName, flux_approval }
        : { name, displayName, template, flux_approval },
    )
}
