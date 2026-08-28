import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

// File d'approbation générique : une demande = un utilisateur veut un flux inédit
// pour un provider en mode `manual`. Un admin l'accepte (le flux est créé et
// l'utilisateur abonné) ou la refuse.
export const fluxRequestsAdminRoute = new Hono<{ Bindings: Bindings }>()

fluxRequestsAdminRoute.use('*', authMiddleware)
fluxRequestsAdminRoute.use('*', requireAdmin)

// GET /ui/flux-requests — toutes les demandes, avec l'e-mail du demandeur.
fluxRequestsAdminRoute.get('/', async (c) => {
  const requests = await (await getStore(c.env.DATABASE_URL)).listFluxRequests()
  return c.json({ requests })
})

// POST /ui/flux-requests/:id/approve — crée/réutilise la source et abonne le
// demandeur. Body optionnel : `{ config }` pour préconfigurer le flux.
fluxRequestsAdminRoute.post('/:id/approve', async (c) => {
  const requestId = c.req.param('id')
  const store = await getStore(c.env.DATABASE_URL)

  const request = await store.getFluxRequest(requestId)
  if (!request) return c.json({ error: 'Request not found' }, 404)
  if (request.status === 'approved') {
    return c.json({ error: 'Request already approved' }, 409)
  }

  const body = await c.req
    .json<{ config?: Record<string, unknown> }>()
    .catch(() => ({}) as { config?: Record<string, unknown> })
  const config = body.config ?? {}

  // Ne jamais convertir en `request.provider` un dépôt déjà suivi sous un autre
  // provider : ses abonnés perdraient leur flux.
  const conflicting = await store.findSourceByUrl(request.url)
  if (conflicting && conflicting.type !== request.provider) {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }

  let source = conflicting
  if (source) {
    await store.updateSourceConfig(source.id, config)
  } else {
    source = await store.createSource({
      url: request.url,
      type: request.provider,
      config,
    })
  }

  await store.subscribe(request.user_id, source.id)
  await store.setFluxRequestStatus(requestId, 'approved')

  return c.json({ success: true, repository_id: source.id })
})

// POST /ui/flux-requests/:id/reject
fluxRequestsAdminRoute.post('/:id/reject', async (c) => {
  const requestId = c.req.param('id')
  const store = await getStore(c.env.DATABASE_URL)

  const request = await store.getFluxRequest(requestId)
  if (!request) return c.json({ error: 'Request not found' }, 404)
  if (request.status !== 'pending') {
    return c.json({ error: 'Request is not pending' }, 409)
  }

  await store.setFluxRequestStatus(requestId, 'rejected')
  return c.json({ success: true })
})
