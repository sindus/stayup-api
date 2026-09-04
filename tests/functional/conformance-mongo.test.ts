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

runDataStoreConformance('MongoDB', {
  async freshStore(): Promise<DataStore> {
    const name = `conformance_${++counter}`
    created.push(name)
    const db = client.db(name)
    await db.dropDatabase()
    await ensureIndexes(db)
    return new MongoStore(db)
  },

  // Le contenu vit dans la collection unique `connector_item` : c'est le
  // contrat `DataStore` lui-même (registerProvider/insertContentItems) qui
  // sait l'atteindre pour ce moteur — le test n'a plus besoin de le savoir aussi.
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
