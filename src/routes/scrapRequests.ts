import { Hono } from 'hono'
import { getSql } from '../db/client.js'
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
  const sql = getSql(c.env.DATABASE_URL)

  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM scrap_request
    WHERE user_id = ${userId} AND url = ${url} AND status = 'pending'
  `
  if (existing)
    return c.json(
      { error: 'A pending request already exists for this URL' },
      409,
    )

  const id = crypto.randomUUID()
  const [row] = await sql<
    { id: string; url: string; status: string; created_at: string }[]
  >`
    INSERT INTO scrap_request (id, user_id, url)
    VALUES (${id}, ${userId}, ${url})
    RETURNING id, url, status, created_at
  `

  return c.json(row, 201)
})

// ─── Admin routes ──────────────────────────────────────────────────────────────

export const scrapRequestsAdminRoute = new Hono<{ Bindings: Bindings }>()

scrapRequestsAdminRoute.use('*', authMiddleware)
scrapRequestsAdminRoute.use('*', requireAdmin)

// GET /ui/scrap-requests — list all requests with requester email
scrapRequestsAdminRoute.get('/', async (c) => {
  const sql = getSql(c.env.DATABASE_URL)

  const requests = await sql<
    {
      id: string
      user_id: string
      user_email: string
      url: string
      status: string
      created_at: string
    }[]
  >`
    SELECT sr.id, sr.user_id, u.email AS user_email, sr.url, sr.status, sr.created_at
    FROM scrap_request sr
    JOIN "user" u ON u.id = sr.user_id
    ORDER BY sr.created_at DESC
  `

  return c.json({ requests })
})

// POST /ui/scrap-requests/:id/approve — approve a request: create repo + auto-subscribe user
scrapRequestsAdminRoute.post('/:id/approve', async (c) => {
  const requestId = c.req.param('id')
  const sql = getSql(c.env.DATABASE_URL)

  const [request] = await sql<
    { id: string; user_id: string; status: string }[]
  >`
    SELECT id, user_id, status FROM scrap_request WHERE id = ${requestId}
  `
  if (!request) return c.json({ error: 'Request not found' }, 404)
  if (request.status === 'approved')
    return c.json({ error: 'Request already approved' }, 409)

  const body = await c.req.json<{
    url: string
    config: Record<string, unknown>
  }>()
  if (!body.url?.trim()) return c.json({ error: 'url is required' }, 400)

  const url = body.url.trim()

  const [repo] = await sql<{ id: number }[]>`
    INSERT INTO repository (url, type, config)
    VALUES (${url}, 'scrap', ${JSON.stringify(body.config ?? {})}::jsonb)
    ON CONFLICT (url) DO UPDATE SET
      type   = EXCLUDED.type,
      config = EXCLUDED.config
    RETURNING id
  `

  const linkId = crypto.randomUUID()
  try {
    await sql`
      INSERT INTO user_repository (id, user_id, repository_id)
      VALUES (${linkId}, ${request.user_id}, ${repo.id})
    `
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err
  }

  await sql`
    UPDATE scrap_request SET status = 'approved' WHERE id = ${requestId}
  `

  return c.json({ success: true, repository_id: repo.id })
})

// POST /ui/scrap-requests/:id/reject — reject a pending request
scrapRequestsAdminRoute.post('/:id/reject', async (c) => {
  const requestId = c.req.param('id')
  const sql = getSql(c.env.DATABASE_URL)

  const [request] = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM scrap_request WHERE id = ${requestId}
  `
  if (!request) return c.json({ error: 'Request not found' }, 404)
  if (request.status !== 'pending')
    return c.json({ error: 'Request is not pending' }, 409)

  await sql`UPDATE scrap_request SET status = 'rejected' WHERE id = ${requestId}`

  return c.json({ success: true })
})
