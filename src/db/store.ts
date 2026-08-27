/**
 * Choisit l'adaptateur de base de données à partir de l'URL de connexion.
 *
 * C'est le seul endroit qui connaît la liste des moteurs pris en charge :
 * ajouter un backend, c'est écrire un adaptateur et l'enregistrer ici.
 *
 * Les pilotes sont chargés à la demande. Un déploiement PostgreSQL n'installe
 * donc jamais le pilote SQLite, et réciproquement — c'est pour ça que cette
 * fonction est asynchrone.
 */

import { getSql } from './client.js'
import type { DataStore } from './port.js'
import { PostgresStore } from './postgres.js'

interface Adapter {
  schemes: string[]
  /** Le paquet npm à installer pour ce moteur, s'il n'est pas déjà là. */
  driver?: string
  create: (url: string) => Promise<DataStore>
}

const ADAPTERS: Adapter[] = [
  {
    schemes: ['postgres:', 'postgresql:'],
    create: async (url) => new PostgresStore(getSql(url)),
  },
  {
    schemes: ['sqlite:', 'file:'],
    driver: 'better-sqlite3',
    create: async (url) => {
      const { SqliteStore } = await import('./sqlite.js')
      const { default: Database } = await import('better-sqlite3')
      // sqlite:///chemin/vers/base.db — ou sqlite::memory:
      const path = url
        .replace(/^sqlite:(\/\/)?/, '')
        .replace(/^file:(\/\/)?/, '')
      const db = new Database(path || ':memory:')
      return new SqliteStore({
        all: (sql, params = []) => db.prepare(sql).all(...(params as never[])),
        run: (sql, params = []) => {
          db.prepare(sql).run(...(params as never[]))
        },
      })
    },
  },
]

export const SUPPORTED_SCHEMES = ADAPTERS.flatMap((a) => a.schemes)

export async function getStore(connectionString: string): Promise<DataStore> {
  // Une URL sans schéma reconnu est une erreur de configuration, pas une donnée
  // d'exécution : mieux vaut le dire tout de suite qu'échouer à la première requête.
  const scheme = connectionString.slice(0, connectionString.indexOf(':') + 1)
  const adapter = ADAPTERS.find((a) => a.schemes.includes(scheme))
  if (!adapter) {
    throw new Error(
      `Base de données non prise en charge : "${scheme || connectionString}". ` +
        `Schémas reconnus : ${SUPPORTED_SCHEMES.join(', ')}`,
    )
  }

  try {
    return await adapter.create(connectionString)
  } catch (err) {
    // Le cas le plus fréquent : le pilote n'est pas installé. Le dire clairement
    // vaut mieux qu'un « Cannot find module » sorti du chargeur.
    if (
      adapter.driver &&
      (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error(
        `Le pilote "${adapter.driver}" est requis pour ${scheme} mais n'est pas installé. ` +
          `Lancez : npm install ${adapter.driver}`,
      )
    }
    throw err
  }
}
