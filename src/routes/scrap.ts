import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const scrapRoute = new Hono<{ Bindings: Bindings }>()

scrapRoute.use('*', authMiddleware)

// GET /scrap — list all scrap repos with subscription status for the current user
scrapRoute.get('/', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub ?? ''
  const sql = getSql(c.env.DATABASE_URL)

  const repos = await sql<
    {
      id: number
      url: string
      config: Record<string, unknown>
      created_at: string
      is_subscribed: boolean
    }[]
  >`
    SELECT
      r.id,
      r.url,
      r.config,
      r.created_at,
      EXISTS (
        SELECT 1 FROM user_repository ur
        WHERE ur.repository_id = r.id AND ur.user_id = ${userId}
      ) AS is_subscribed
    FROM repository r
    WHERE r.type = 'scrap'
    ORDER BY r.id
  `

  return c.json({ repos })
})

// POST /scrap/:repoId/subscribe — subscribe current user to a scrap feed
scrapRoute.post('/:repoId/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const repoId = Number.parseInt(c.req.param('repoId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [repo] = await sql<{ id: number }[]>`
    SELECT id FROM repository WHERE id = ${repoId} AND type = 'scrap'
  `
  if (!repo) return c.json({ error: 'Scrap feed not found' }, 404)

  const id = crypto.randomUUID()
  try {
    await sql`
      INSERT INTO user_repository (id, user_id, repository_id)
      VALUES (${id}, ${userId}, ${repoId})
    `
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Already subscribed' }, 409)
    }
    throw err
  }

  return c.json({ success: true }, 201)
})

// DELETE /scrap/:repoId/subscribe — unsubscribe without cascade-deleting the repo
scrapRoute.delete('/:repoId/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const repoId = Number.parseInt(c.req.param('repoId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const result = await sql<{ id: string }[]>`
    DELETE FROM user_repository
    WHERE user_id = ${userId} AND repository_id = ${repoId}
    RETURNING id
  `

  if (result.length === 0) return c.json({ error: 'Not subscribed' }, 404)

  return c.json({ success: true })
})
