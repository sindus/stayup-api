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

/**
 * Charge un pilote à l'exécution sans que l'empaqueteur Workers ne l'embarque.
 *
 * Un `import('mongodb')` littéral serait résolu à la compilation et le pilote
 * entier finirait dans le bundle déployé sur Cloudflare, où il ne pourra jamais
 * s'exécuter faute de socket TCP. Passer par une variable ne laisse rien à
 * résoudre : sous Node, l'import fonctionne ; sous Workers, il n'est jamais atteint.
 */
function loadDriver(name: string): Promise<unknown> {
  return import(name)
}

// Aliasés parce que `typeof import('…')` écrit en ligne se fait recouper par le
// formateur, qui en sort une syntaxe invalide.
type SqliteDriver = typeof import('better-sqlite3')
type Mysql2Driver = typeof import('mysql2/promise')
type MongoDriver = typeof import('mongodb')

interface Adapter {
  schemes: string[]
  /** Le paquet npm à installer pour ce moteur, s'il n'est pas déjà là. */
  driver?: string
  create: (url: string) => Promise<DataStore>
}

/**
 * Les moteurs qui ne tournent que sur Node gardent leur connexion.
 *
 * La règle d'isolation de Workers — interdisant de réutiliser une connexion
 * ouverte par une autre requête, d'où la connexion par appel côté Postgres — ne
 * s'applique qu'à Workers. MongoDB et MySQL y sont de toute façon inatteignables
 * faute de socket TCP : rouvrir une connexion à chaque requête n'y protégerait
 * de rien et coûterait une poignée d'allers-retours.
 */
const kept = new Map<string, Promise<DataStore>>()

function keep(url: string, open: () => Promise<DataStore>): Promise<DataStore> {
  const cached = kept.get(url)
  if (cached) return cached

  const store = open()
  kept.set(url, store)
  // Un échec ne doit pas rester en cache, sinon la base ne remonte jamais.
  store.catch(() => kept.delete(url))
  return store
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
      // Module CommonJS : le constructeur arrive sous `default`.
      const { default: Database } = (await loadDriver('better-sqlite3')) as {
        default: SqliteDriver
      }
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
  {
    schemes: ['mysql:', 'mariadb:'],
    driver: 'mysql2',
    create: (url) =>
      keep(url, async () => {
        const { MysqlStore, mysqlClient } = await import('./mysql.js')
        const mysql = (await loadDriver('mysql2/promise')) as Mysql2Driver
        // Une seule connexion, pas un pool : les transactions n'ont de sens que
        // si les requêtes qui les composent empruntent la même.
        const conn = await mysql.createConnection({
          uri: url.replace(/^mariadb:/, 'mysql:'),
          dateStrings: true,
        })
        // Connexion perdue : on la sort du cache pour que la suivante rouvre.
        conn.on('error', () => kept.delete(url))
        return new MysqlStore(mysqlClient(conn))
      }),
  },
  {
    schemes: ['mongodb:', 'mongodb+srv:'],
    driver: 'mongodb',
    create: (url) =>
      keep(url, async () => {
        const { MongoStore, ensureIndexes } = await import('./mongo.js')
        const { MongoClient } = (await loadDriver('mongodb')) as MongoDriver
        const client = new MongoClient(url)
        await client.connect()
        // L'URL doit nommer la base : mongodb://hôte:27017/stayup
        const db = client.db()
        await ensureIndexes(db)
        return new MongoStore(db)
      }),
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

// ─── Bases secondaires (agrégation multi-sources) ────────────────────────────

/** Le moteur d'une URL de connexion, ou null si le schéma n'est pas reconnu. */
export function engineOf(connectionString: string): string | null {
  const scheme = connectionString.slice(0, connectionString.indexOf(':') + 1)
  const adapter = ADAPTERS.find((a) => a.schemes.includes(scheme))
  if (!adapter) return null
  // Le premier schéma de l'adaptateur sert de nom canonique (`postgres:` etc.).
  return adapter.schemes[0].replace(':', '')
}

export interface OpenedDataSource {
  id: number
  name: string
  engine: string
  store: DataStore
}

/**
 * Ouvre un store par base secondaire déclarée dans la base principale. Une base
 * injoignable est *ignorée* (avec un log) plutôt que de casser tout le feed :
 * une source externe hors ligne ne doit pas priver l'utilisateur du reste.
 */
export async function openSecondaryStores(
  primary: DataStore,
  jwtSecret: string,
): Promise<OpenedDataSource[]> {
  const rows = await primary.listDataSources().catch(() => [])
  if (rows.length === 0) return []
  const { decryptSecret } = await import('./secretbox.js')

  const opened: OpenedDataSource[] = []
  for (const row of rows) {
    try {
      const url = await decryptSecret(row.url_enc, jwtSecret)
      opened.push({
        id: row.id,
        name: row.name,
        engine: row.engine,
        store: await getStore(url),
      })
    } catch (err) {
      console.error(`Data source ${row.id} (${row.name}) unavailable:`, err)
    }
  }
  return opened
}
