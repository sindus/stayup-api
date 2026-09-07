import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'
import { closeSql, getSql, trackOpenConnections } from '../../src/db/client.js'
import type { DataStore } from '../../src/db/port.js'
import { PostgresStore } from '../../src/db/postgres.js'
import { runDataStoreConformance } from '../conformance/datastore.js'

trackOpenConnections(true)

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(join(__dirname, '../../src/db/schema.sql'), 'utf-8')

const CONNECTION =
  process.env.DATABASE_URL ??
  `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup_test'}`

const sql = getSql(CONNECTION)

/** One isolated schema per test case: the suite requires a truly fresh database. */
let counter = 0

afterAll(async () => {
  for (let i = 1; i <= counter; i++) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaName(i)} CASCADE`)
  }
  await closeSql()
})

function schemaName(n: number): string {
  return `conformance_${n}`
}

// Each case runs in its own schema, outside `public`: this is what verifies
// that discovery follows `current_schema()` / the search_path, and not a
// hardcoded schema.
async function freshSchema(): Promise<string> {
  const name = schemaName(++counter)
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
  await sql.unsafe(`CREATE SCHEMA ${name}`)
  return name
}

runDataStoreConformance('PostgreSQL', {
  async freshStore(): Promise<DataStore> {
    const name = await freshSchema()
    const scoped = getSql(
      `${CONNECTION}${CONNECTION.includes('?') ? '&' : '?'}options=-csearch_path%3D${name}`,
    )
    await scoped.unsafe(`SET search_path TO ${name}`)
    await scoped.unsafe(SCHEMA)
    return new PostgresStore(scoped)
  },

  // Content lives in the single `connector_item` table: it is the `DataStore`
  // contract itself (registerProvider/insertContentItems) that knows how to
  // reach it for this engine — the test no longer needs to know it either.
  async seedProvider(store, provider, rows) {
    await store.registerProvider({ name: provider, displayName: provider })
    await store.insertContentItems(
      provider,
      rows.map((row) => ({
        repositoryId: row.repository_id,
        content: row.content,
        datetime: row.datetime ?? null,
        executedAt: row.executed_at,
        success: true,
      })),
    )
  },

  async seedRegistry(store, entries) {
    for (const e of entries) {
      await store.registerProvider({
        name: e.name,
        displayName: e.display_name,
        sortOrder: e.sort_order,
        template: e.template,
      })
    }
  },
})
