import { Hono } from 'hono'
import { listProviders } from '../db/providers.js'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

// Réglages par provider, côté admin. Aujourd'hui : le mode d'ajout de flux.
export const adminProvidersRoute = new Hono<{ Bindings: Bindings }>()

adminProvidersRoute.use('*', authMiddleware)
adminProvidersRoute.use('*', requireAdmin)

// GET /ui/providers — providers découverts + leur mode d'approbation.
adminProvidersRoute.get('/', async (c) => {
  const providers = await listProviders(await getStore(c.env.DATABASE_URL))
  return c.json({
    providers: providers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      flux_approval: p.flux_approval,
    })),
  })
})

// PATCH /ui/providers/:name — { flux_approval: 'auto' | 'manual' }
adminProvidersRoute.patch('/:name', async (c) => {
  const name = c.req.param('name')
  const body = await c.req.json<{ flux_approval?: string }>()
  if (body.flux_approval !== 'auto' && body.flux_approval !== 'manual') {
    return c.json({ error: "flux_approval must be 'auto' or 'manual'" }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  if (!(await store.providerExists(name))) {
    return c.json({ error: 'Provider not found' }, 404)
  }

  await store.setProviderApproval(name, body.flux_approval)
  return c.json({ success: true })
})
