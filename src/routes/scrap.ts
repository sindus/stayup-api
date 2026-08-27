import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const scrapRoute = new Hono<{ Bindings: Bindings }>()

scrapRoute.use('*', authMiddleware)

// GET /scrap — list all scrap repos with subscription status for the current user
scrapRoute.get('/', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub ?? ''
  const repos = await getStore(c.env.DATABASE_URL).listSourcesOfType(
    'scrap',
    userId,
  )
  return c.json({ repos })
})

// POST /scrap/:repoId/subscribe — subscribe current user to a scrap feed
scrapRoute.post('/:repoId/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const repoId = Number.parseInt(c.req.param('repoId'), 10)
  if (Number.isNaN(repoId))
    return c.json({ error: 'Scrap feed not found' }, 404)

  const store = getStore(c.env.DATABASE_URL)
  const source = await store.getSource(repoId)
  if (!source || source.type !== 'scrap') {
    return c.json({ error: 'Scrap feed not found' }, 404)
  }

  const link = await store.subscribe(userId, repoId)
  if (!link) return c.json({ error: 'Already subscribed' }, 409)

  return c.json({ success: true }, 201)
})

// DELETE /scrap/:repoId/subscribe — unsubscribe without cascade-deleting the repo
scrapRoute.delete('/:repoId/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const repoId = Number.parseInt(c.req.param('repoId'), 10)
  if (Number.isNaN(repoId)) return c.json({ error: 'Not subscribed' }, 404)

  const removed = await getStore(c.env.DATABASE_URL).unsubscribe(userId, repoId)
  if (!removed) return c.json({ error: 'Not subscribed' }, 404)

  return c.json({ success: true })
})
