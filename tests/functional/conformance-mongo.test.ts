import { MongoClient } from 'mongodb'
import { afterAll } from 'vitest'
import { MongoStore, ensureIndexes } from '../../src/db/mongo.js'
import type { DataStore } from '../../src/db/port.js'
import { runDataStoreConformance } from '../conformance/datastore.js'

const URL =
  process.env.MONGO_URL ??
  `mongodb://${process.env.MONGO_HOST ?? 'localhost'}:${process.env.MONGO_PORT ?? '27017'}`

const client = new MongoClient(URL)

/** Une base par cas de test : la suite exige une base vraiment neuve. */
let counter = 0
const created: string[] = []

afterAll(async () => {
  for (const name of created) await client.db(name).dropDatabase()
  await client.close()
})

/** MongoStore garde sa base pour lui ; le harnais a besoin d'y semer des données. */
function dbOf(store: DataStore) {
  return (store as unknown as { db: ReturnType<MongoClient['db']> }).db
}

runDataStoreConformance('MongoDB', {
  async freshStore(): Promise<DataStore> {
    const name = `conformance_${++counter}`
    created.push(name)
    const db = client.db(name)
    await db.dropDatabase()
    await ensureIndexes(db)
    return new MongoStore(db)
  },

  async seedProvider(store, provider, rows) {
    const db = dbOf(store)
    // C'est le provider qui crée son espace de stockage, pas l'API. En Mongo,
    // une collection n'existe qu'une fois créée : sans ça, un provider sans
    // contenu resterait invisible, alors qu'il est bel et bien installé.
    await db.createCollection(`connector_${provider}`)
    if (rows.length === 0) return
    await db.collection(`connector_${provider}`).insertMany(
      rows.map((row) => ({
        repository_id: row.repository_id,
        content: row.content,
        datetime: row.datetime ?? null,
        executed_at: row.executed_at,
        success: true,
      })),
    )
  },

  async seedRegistry(store, entries) {
    const db = dbOf(store)
    for (const e of entries) {
      await db
        .collection('provider_registry')
        .updateOne(
          { _id: e.name as never },
          { $set: { display_name: e.display_name, sort_order: e.sort_order } },
          { upsert: true },
        )
    }
  },
})
