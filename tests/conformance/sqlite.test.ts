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

/** Adapte better-sqlite3 au peu que SqliteStore attend d'un client. */
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

  async seedProvider(store, provider, rows) {
    const db = (store as unknown as { db: SqliteClient }).db
    // C'est le provider qui crée son espace de stockage, pas l'API : le test
    // reproduit exactement ce que la documentation lui demande de faire.
    db.run(`CREATE TABLE IF NOT EXISTS "connector_${provider}" (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES repository(id),
      content       TEXT NOT NULL,
      datetime      TEXT,
      executed_at   TEXT NOT NULL,
      success       INTEGER NOT NULL DEFAULT 1
    )`)
    for (const row of rows) {
      db.run(
        `INSERT INTO "connector_${provider}" (repository_id, content, datetime, executed_at, success)
         VALUES (?, ?, ?, ?, 1)`,
        [row.repository_id, row.content, row.datetime ?? null, row.executed_at],
      )
    }
  },

  async seedRegistry(store, entries) {
    const db = (store as unknown as { db: SqliteClient }).db
    for (const e of entries) {
      db.run(
        `INSERT INTO provider_registry (name, display_name, sort_order, template) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           display_name = excluded.display_name, template = excluded.template`,
        [
          e.name,
          e.display_name,
          e.sort_order,
          e.template == null ? null : JSON.stringify(e.template),
        ],
      )
    }
  },
})
