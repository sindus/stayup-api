import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

// Generic approval queue: one request = a user wants a brand-new flux for a
// provider in `manual` mode. An admin approves it (the flux is created and the
// user subscribed) or rejects it.
export const fluxRequestsAdminRoute = new Hono<{ Bindings: Bindings }>()

fluxRequestsAdminRoute.use('*', authMiddleware)
fluxRequestsAdminRoute.use('*', requireAdmin)

// GET /ui/flux-requests — every request, with the requester's e-mail.
fluxRequestsAdminRoute.get('/', async (c) => {
  const requests = await (await getStore(c.env.DATABASE_URL)).listFluxRequests()
  return c.json({ requests })
})

// POST /ui/flux-requests/:id/approve — creates/reuses the source and subscribes
// the requester. Optional body: `{ config }` to preconfigure the flux.
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

  // Never convert to `request.provider` a repository already tracked under
  // another provider: its subscribers would lose their flux.
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
