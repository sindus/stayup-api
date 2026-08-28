import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

// Version générique de l'ancien routeur `/scrap` : lister les flux existants d'un
// provider et s'y abonner / s'en désabonner, quel que soit le provider.
export const providerFluxesRoute = new Hono<{ Bindings: Bindings }>()

providerFluxesRoute.use('*', authMiddleware)

// GET /providers/:provider/fluxes — tous les flux de ce provider, avec l'état
// d'abonnement de l'utilisateur courant.
providerFluxesRoute.get('/:provider/fluxes', async (c) => {
  const provider = c.req.param('provider')
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub ?? ''
  const fluxes = await (await getStore(c.env.DATABASE_URL)).listSourcesOfType(
    provider,
    userId,
  )
  return c.json({ fluxes })
})

// POST /providers/:provider/fluxes/:id/subscribe — s'abonner à un flux existant.
providerFluxesRoute.post('/:provider/fluxes/:id/subscribe', async (c) => {
  const provider = c.req.param('provider')
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Flux not found' }, 404)

  const store = await getStore(c.env.DATABASE_URL)
  const source = await store.getSource(id)
  if (!source || source.type !== provider) {
    return c.json({ error: 'Flux not found' }, 404)
  }

  const link = await store.subscribe(userId, id)
  if (!link) return c.json({ error: 'Already subscribed' }, 409)

  return c.json({ success: true }, 201)
})

// DELETE /providers/:provider/fluxes/:id/subscribe — se désabonner sans supprimer
// le flux (il peut avoir d'autres abonnés / être géré par un admin).
providerFluxesRoute.delete('/:provider/fluxes/:id/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Not subscribed' }, 404)

  const removed = await (await getStore(c.env.DATABASE_URL)).unsubscribe(
    userId,
    id,
  )
  if (!removed) return c.json({ error: 'Not subscribed' }, 404)

  return c.json({ success: true })
})
