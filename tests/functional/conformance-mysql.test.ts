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
  await Promise.all(connections.map((c) => c.end()))
  if (databases.length > 0) {
    const admin = await mysql.createConnection(BASE)
    // Une base par cas de test (voir plus haut) : à ce nombre, les DROP
    // séquentiels dépassent le hookTimeout par défaut de Vitest.
    await Promise.all(
      databases.map((name) =>
        admin.query(`DROP DATABASE IF EXISTS \`${name}\``),
      ),
    )
    await admin.end()
  }
}, 30000)

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

    return new MysqlStore(mysqlClient(conn))
  },

  // Le contenu vit dans la table unique `connector_item` : c'est le contrat
  // `DataStore` lui-même (registerProvider/insertContentItems) qui sait
  // l'atteindre pour ce moteur — le test n'a plus besoin de le savoir aussi,
  // dates ISO comprises : c'est `MysqlStore` qui les traduit pour MySQL.
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
