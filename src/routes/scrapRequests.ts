import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const scrapRequestsUserRoute = new Hono<{ Bindings: Bindings }>()

scrapRequestsUserRoute.use('*', authMiddleware)

// POST /scrap/requests — user submits a URL request for scraping
scrapRequestsUserRoute.post('/', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ url?: string }>()
  if (!body.url?.trim()) return c.json({ error: 'url is required' }, 400)

  const url = body.url.trim()
  const store = await getStore(c.env.DATABASE_URL)

  const existing = await store.findPendingScrapRequest(userId, url)
  if (existing)
    return c.json(
      { error: 'A pending request already exists for this URL' },
      409,
    )

  const row = await store.createScrapRequest(userId, url)

  return c.json(row, 201)
})

// ─── Admin routes ──────────────────────────────────────────────────────────────

export const scrapRequestsAdminRoute = new Hono<{ Bindings: Bindings }>()

scrapRequestsAdminRoute.use('*', authMiddleware)
scrapRequestsAdminRoute.use('*', requireAdmin)

// GET /ui/scrap-requests — list all requests with requester email
scrapRequestsAdminRoute.get('/', async (c) => {
  const requests = await (
    await getStore(c.env.DATABASE_URL)
  ).listScrapRequests()

  return c.json({ requests })
})

// POST /ui/scrap-requests/:id/approve — approve a request: create repo + auto-subscribe user
scrapRequestsAdminRoute.post('/:id/approve', async (c) => {
  const requestId = c.req.param('id')
  const store = await getStore(c.env.DATABASE_URL)

  const request = await store.getScrapRequest(requestId)
  if (!request) return c.json({ error: 'Request not found' }, 404)
  if (request.status === 'approved')
    return c.json({ error: 'Request already approved' }, 409)

  const body = await c.req.json<{
    url: string
    config: Record<string, unknown>
  }>()
  if (!body.url?.trim()) return c.json({ error: 'url is required' }, 400)

  const url = body.url.trim()

  // Approuver une demande ne doit pas convertir en 'scrap' un dépôt déjà suivi sous
  // un autre provider : ses abonnés perdraient leur flux et les lignes connector_*
  // restées derrière empêcheraient toute suppression du dépôt.
  const conflicting = await store.findSourceByUrl(url)
  if (conflicting && conflicting.type !== 'scrap') {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }

  let repo = conflicting
  if (repo) {
    await store.updateSourceConfig(repo.id, body.config ?? {})
  } else {
    repo = await store.createSource({
      url,
      type: 'scrap',
      config: body.config ?? {},
    })
  }

  // Un abonnement déjà présent n'est pas une erreur : la demande est approuvée.
  await store.subscribe(request.user_id, repo.id)
  await store.setScrapRequestStatus(requestId, 'approved')

  return c.json({ success: true, repository_id: repo.id })
})

// POST /ui/scrap-requests/:id/reject — reject a pending request
scrapRequestsAdminRoute.post('/:id/reject', async (c) => {
  const requestId = c.req.param('id')
  const store = await getStore(c.env.DATABASE_URL)

  const request = await store.getScrapRequest(requestId)
  if (!request) return c.json({ error: 'Request not found' }, 404)
  if (request.status !== 'pending')
    return c.json({ error: 'Request is not pending' }, 409)

  await store.setScrapRequestStatus(requestId, 'rejected')

  return c.json({ success: true })
})
