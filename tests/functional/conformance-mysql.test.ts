import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { afterAll } from 'vitest'
import { MysqlStore, mysqlClient } from '../../src/db/mysql.js'
import type { DataStore } from '../../src/db/port.js'
import { runDataStoreConformance } from '../conformance/datastore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(
  join(__dirname, '../../src/db/schema.mysql.sql'),
  'utf-8',
)

const BASE = {
  host: process.env.MYSQL_HOST ?? 'localhost',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'root',
  // Le contrat parle de chaînes de dates, pas d'objets Date.
  dateStrings: true,
  multipleStatements: true,
}

/** Une base par cas de test : la suite exige une base vraiment neuve. */
let counter = 0
const connections: mysql.Connection[] = []
const databases: string[] = []

afterAll(async () => {
  for (const c of connections) await c.end()
  if (databases.length > 0) {
    const admin = await mysql.createConnection(BASE)
    for (const name of databases) {
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
    }
    await admin.end()
  }
})

/** Le contenu semé passe par la connexion du store, pas par une autre. */
const conns = new WeakMap<DataStore, mysql.Connection>()

/** MySQL n'accepte pas le « T » ni le « Z » d'ISO 8601 dans un DATETIME. */
function toMysqlDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

runDataStoreConformance('MySQL', {
  async freshStore(): Promise<DataStore> {
    const name = `conformance_${++counter}`
    const admin = await mysql.createConnection(BASE)
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
    await admin.query(`CREATE DATABASE \`${name}\``)
    await admin.end()
    databases.push(name)

    // Une seule connexion, pas un pool : START TRANSACTION n'a de sens que si
    // les requêtes qui suivent empruntent la même.
    const conn = await mysql.createConnection({ ...BASE, database: name })
    connections.push(conn)
    await conn.query(SCHEMA)

    const store = new MysqlStore(mysqlClient(conn))
    conns.set(store, conn)
    return store
  },

  async seedProvider(store, provider, rows) {
    const conn = conns.get(store)
    if (!conn) throw new Error('connexion introuvable pour ce store')
    // C'est le provider qui crée son espace de stockage, pas l'API : le test
    // reproduit exactement ce que la documentation lui demande de faire.
    await conn.query(`CREATE TABLE IF NOT EXISTS \`connector_${provider}\` (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      repository_id INT NOT NULL,
      content       TEXT NOT NULL,
      \`datetime\`  DATETIME(3),
      executed_at   DATETIME(3) NOT NULL,
      success       TINYINT(1) NOT NULL DEFAULT 1,
      FOREIGN KEY (repository_id) REFERENCES repository(id)
    )`)
    for (const row of rows) {
      await conn.query(
        `INSERT INTO \`connector_${provider}\` (repository_id, content, \`datetime\`, executed_at, success)
         VALUES (?, ?, ?, ?, 1)`,
        [
          row.repository_id,
          row.content,
          row.datetime ? toMysqlDate(row.datetime) : null,
          toMysqlDate(row.executed_at),
        ],
      )
    }
  },

  async seedRegistry(store, entries) {
    const conn = conns.get(store)
    if (!conn) throw new Error('connexion introuvable pour ce store')
    for (const e of entries) {
      await conn.query(
        `INSERT INTO provider_registry (name, display_name, sort_order) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
        [e.name, e.display_name, e.sort_order],
      )
    }
  },
})
