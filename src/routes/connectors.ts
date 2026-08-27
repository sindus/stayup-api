import { Hono } from 'hono'
import { listProviders } from '../db/providers.js'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const connectorsRoute = new Hono<{ Bindings: Bindings }>()

connectorsRoute.use('*', authMiddleware)
connectorsRoute.use('/latest', requireAdmin)

// GET /connectors/providers — liste légère des providers disponibles (nom + libellé),
// pour construire une UI dynamique sans tirer toutes les données.
connectorsRoute.get('/providers', async (c) => {
  const providers = await listProviders(await getStore(c.env.DATABASE_URL))
  return c.json({
    providers: providers.map(({ name, displayName }) => ({
      name,
      displayName,
    })),
  })
})

connectorsRoute.get('/', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const data: Record<string, unknown[]> = {}
  for (const name of await store.listProviderNames()) {
    data[name] = await store.allContent(name)
  }
  return c.json({ connectors: data })
})

connectorsRoute.get('/latest', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const data: Record<string, unknown[]> = {}
  for (const name of await store.listProviderNames()) {
    data[name] = await store.latestPerSource(name)
  }
  return c.json({ latest: data })
})

connectorsRoute.get('/:name', async (c) => {
  const name = c.req.param('name')
  const store = await getStore(c.env.DATABASE_URL)

  if (!(await store.providerExists(name))) {
    return c.json({ error: `Connector '${name}' not found` }, 404)
  }

  return c.json({ connector: name, data: await store.latestPerSource(name) })
})
