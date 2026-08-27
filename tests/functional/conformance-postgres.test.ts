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

/** Un schéma isolé par cas de test : la suite exige une base vraiment neuve. */
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

// Chaque cas tourne dans son propre schéma, hors de `public` : c'est ce qui
// vérifie que la découverte suit `current_schema()` / le search_path, et non
// un schéma écrit en dur.
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

  async seedProvider(store, provider, rows) {
    const scoped = (store as unknown as { sql: typeof sql }).sql
    // C'est le provider qui crée son espace de stockage, pas l'API.
    await scoped.unsafe(`CREATE TABLE IF NOT EXISTS "connector_${provider}" (
      id            SERIAL PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repository(id),
      content       TEXT NOT NULL,
      datetime      TIMESTAMPTZ,
      executed_at   TIMESTAMPTZ NOT NULL,
      success       BOOLEAN NOT NULL DEFAULT TRUE
    )`)
    for (const row of rows) {
      await scoped.unsafe(
        `INSERT INTO "connector_${provider}" (repository_id, content, datetime, executed_at, success)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [row.repository_id, row.content, row.datetime ?? null, row.executed_at],
      )
    }
  },

  async seedRegistry(store, entries) {
    const scoped = (store as unknown as { sql: typeof sql }).sql
    for (const e of entries) {
      await scoped.unsafe(
        `INSERT INTO provider_registry (name, display_name, sort_order) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [e.name, e.display_name, e.sort_order],
      )
    }
  },
})
