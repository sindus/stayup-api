import { Hono } from 'hono'
import { listMergedProviders } from '../db/providers.js'
import { getStore, openSecondaryStores } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const connectorsRoute = new Hono<{ Bindings: Bindings }>()

connectorsRoute.use('*', authMiddleware)
connectorsRoute.use('/latest', requireAdmin)

// GET /connectors/providers — lightweight list of available providers (name +
// label + approval mode), merged across the primary database and every
// secondary database: a single entry per provider name.
connectorsRoute.get('/providers', async (c) => {
  const primary = await getStore(c.env.DATABASE_URL)
  const secondaries = await openSecondaryStores(primary, c.env.JWT_SECRET)
  const providers = await listMergedProviders([
    primary,
    ...secondaries.map((s) => s.store),
  ])
  return c.json({
    // `template` (the display manifest declared by the provider) is only
    // present for those that publish one; otherwise apps fall back to their
    // generic rendering. The API does not interpret it. `fluxApproval` tells the
    // app whether adding a flux is immediate (`auto`) or goes through a request
    // (`manual`).
    providers: providers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      fluxApproval: p.flux_approval,
      ...(p.template == null ? {} : { template: p.template }),
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
