import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { DataStore } from '../../src/db/port.js'
import { type SqliteClient, SqliteStore } from '../../src/db/sqlite.js'
import { runDataStoreConformance } from './datastore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(
  join(__dirname, '../../src/db/schema.sqlite.sql'),
  'utf-8',
)

/** Adapts better-sqlite3 to the little SqliteStore expects from a client. */
function client(db: Database.Database): SqliteClient {
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])),
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]))
    },
  }
}

runDataStoreConformance('SQLite', {
  async freshStore(): Promise<DataStore> {
    const db = new Database(':memory:')
    db.exec(SCHEMA)
    return new SqliteStore(client(db))
  },

  // Content lives in the single `connector_item` table, and "having a
  // storage space" now corresponds to the call a connector makes at the very
  // start of its lifecycle (`registerProvider`, before its first collection
  // attempt even): it is the `DataStore` contract itself
  // that knows how to reach both for this engine.
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
