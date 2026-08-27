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
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ name, displayName }) => ({ name, displayName }))
}
