/**
 * Choisit l'adaptateur de base de données à partir de l'URL de connexion.
 *
 * C'est le seul endroit qui connaît la liste des moteurs pris en charge :
 * ajouter un backend, c'est écrire un adaptateur et l'enregistrer ici.
 */

import { getSql } from './client.js'
import type { DataStore } from './port.js'
import { PostgresStore } from './postgres.js'

/** Moteurs pris en charge, et les schémas d'URL qui les désignent. */
const ADAPTERS: { schemes: string[]; create: (url: string) => DataStore }[] = [
  {
    schemes: ['postgres:', 'postgresql:'],
    create: (url) => new PostgresStore(getSql(url)),
  },
]

export const SUPPORTED_SCHEMES = ADAPTERS.flatMap((a) => a.schemes)

export function getStore(connectionString: string): DataStore {
  // Une URL sans schéma reconnu est une erreur de configuration, pas une donnée
  // d'exécution : mieux vaut le dire tout de suite que d'échouer à la première requête.
  const scheme = connectionString.slice(0, connectionString.indexOf(':') + 1)
  const adapter = ADAPTERS.find((a) => a.schemes.includes(scheme))
  if (!adapter) {
    throw new Error(
      `Base de données non prise en charge : "${scheme || connectionString}". ` +
        `Schémas reconnus : ${SUPPORTED_SCHEMES.join(', ')}`,
    )
  }
  return adapter.create(connectionString)
}
