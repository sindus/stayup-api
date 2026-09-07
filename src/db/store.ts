/**
 * Picks the database adapter from the connection URL.
 *
 * This is the only place that knows the list of supported engines: adding a
 * backend means writing an adapter and registering it here.
 *
 * Drivers are loaded on demand. A PostgreSQL deployment therefore never installs
 * the SQLite driver, and vice versa — that is why this function is async.
 */

import { getSql } from './client.js'
import type { DataStore } from './port.js'
import { PostgresStore } from './postgres.js'

/**
 * Loads a driver at runtime without the Workers bundler pulling it in.
 *
 * A literal `import('mongodb')` would be resolved at build time and the whole
 * driver would end up in the bundle deployed to Cloudflare, where it can never
 * run for lack of a TCP socket. Going through a variable leaves nothing to
 * resolve: under Node the import works; under Workers it is never reached.
 */
function loadDriver(name: string): Promise<unknown> {
  return import(name)
}

// Aliased because an inline `typeof import('…')` gets reflowed by the formatter,
// which turns it into invalid syntax.
type SqliteDriver = typeof import('better-sqlite3')
type Mysql2Driver = typeof import('mysql2/promise')
type MongoDriver = typeof import('mongodb')

interface Adapter {
  schemes: string[]
  /** The npm package to install for this engine, if it is not already there. */
  driver?: string
  create: (url: string) => Promise<DataStore>
}

/**
 * Engines that only run on Node keep their connection.
 *
 * The Workers isolation rule — forbidding reuse of a connection opened by
 * another request, hence the per-call connection on the Postgres side — only
 * applies to Workers. MongoDB and MySQL are unreachable there anyway for lack of
 * a TCP socket: reopening a connection on every request would protect nothing
 * and cost a handful of round-trips.
 */
const kept = new Map<string, Promise<DataStore>>()

function keep(url: string, open: () => Promise<DataStore>): Promise<DataStore> {
  const cached = kept.get(url)
  if (cached) return cached

  const store = open()
  kept.set(url, store)
  // A failure must not stay cached, otherwise the database never comes back.
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
      // CommonJS module: the constructor arrives under `default`.
      const { default: Database } = (await loadDriver('better-sqlite3')) as {
        default: SqliteDriver
      }
      // sqlite:///path/to/db.db — or sqlite::memory:
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
        // A single connection, not a pool: transactions only make sense if the
        // queries that compose them use the same one.
        const conn = await mysql.createConnection({
          uri: url.replace(/^mariadb:/, 'mysql:'),
          dateStrings: true,
        })
        // Connection lost: drop it from the cache so the next one reopens.
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
        // The URL must name the database: mongodb://host:27017/stayup
        const db = client.db()
        await ensureIndexes(db)
        return new MongoStore(db)
      }),
  },
]

export const SUPPORTED_SCHEMES = ADAPTERS.flatMap((a) => a.schemes)

export async function getStore(connectionString: string): Promise<DataStore> {
  // A URL with no recognized scheme is a configuration error, not runtime data:
  // better to say so right away than to fail on the first query.
  const scheme = connectionString.slice(0, connectionString.indexOf(':') + 1)
  const adapter = ADAPTERS.find((a) => a.schemes.includes(scheme))
  if (!adapter) {
    throw new Error(
      `Unsupported database: "${scheme || connectionString}". ` +
        `Recognized schemes: ${SUPPORTED_SCHEMES.join(', ')}`,
    )
  }

  try {
    return await adapter.create(connectionString)
  } catch (err) {
    // The most common case: the driver is not installed. Saying so clearly
    // beats a "Cannot find module" thrown by the loader.
    if (
      adapter.driver &&
      (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error(
        `The "${adapter.driver}" driver is required for ${scheme} but is not installed. ` +
          `Run: npm install ${adapter.driver}`,
      )
    }
    throw err
  }
}

// ─── Secondary databases (multi-source aggregation) ──────────────────────────

/** The engine of a connection URL, or null if the scheme is not recognized. */
export function engineOf(connectionString: string): string | null {
  const scheme = connectionString.slice(0, connectionString.indexOf(':') + 1)
  const adapter = ADAPTERS.find((a) => a.schemes.includes(scheme))
  if (!adapter) return null
  // The adapter's first scheme serves as the canonical name (`postgres:` etc.).
  return adapter.schemes[0].replace(':', '')
}

export interface OpenedDataSource {
  id: number
  name: string
  engine: string
  store: DataStore
}

/**
 * Opens one store per secondary database declared in the primary database. An
 * unreachable database is *skipped* (with a log) rather than breaking the whole
 * feed: an offline external source must not deprive the user of the rest.
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
