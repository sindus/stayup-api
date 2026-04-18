import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const adminRepositoriesRoute = new Hono<{ Bindings: Bindings }>()

adminRepositoriesRoute.use('*', authMiddleware)
adminRepositoriesRoute.use('*', requireAdmin)

const connectorTable: Record<string, string> = {
  changelog: 'connector_changelog',
  youtube: 'connector_youtube',
  rss: 'connector_rss',
  scrap: 'connector_scrap',
}

// GET / — list all repositories with subscriber count
adminRepositoriesRoute.get('/', async (c) => {
  const sql = getSql(c.env.DATABASE_URL)
  const rows = await sql<
    {
      id: number
      url: string
      type: string
      config: Record<string, unknown>
      subscriber_count: string
    }[]
  >`
    SELECT r.id, r.url, r.type, r.config,
      COUNT(ur.id)::text AS subscriber_count
    FROM repository r
    LEFT JOIN user_repository ur ON ur.repository_id = r.id
    GROUP BY r.id
    ORDER BY r.id
  `
  return c.json({ repositories: rows })
})

// DELETE /:repoId/data — delete connector data only (keep repository + subscriptions)
adminRepositoriesRoute.delete('/:repoId/data', async (c) => {
  const repoId = Number.parseInt(c.req.param('repoId') as string, 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [repo] = await sql<{ id: number; type: string }[]>`
    SELECT id, type FROM repository WHERE id = ${repoId}
  `
  if (!repo) return c.json({ error: 'Repository not found' }, 404)

  const table = connectorTable[repo.type]
  if (table) {
    await sql.unsafe(`DELETE FROM "${table}" WHERE repository_id = $1`, [
      repoId,
    ])
  }

  return c.json({ success: true })
})

// DELETE /:repoId — full purge (connector data + all user subscriptions + repository)
adminRepositoriesRoute.delete('/:repoId', async (c) => {
  const repoId = Number.parseInt(c.req.param('repoId') as string, 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [repo] = await sql<{ id: number; type: string }[]>`
    SELECT id, type FROM repository WHERE id = ${repoId}
  `
  if (!repo) return c.json({ error: 'Repository not found' }, 404)

  const table = connectorTable[repo.type]
  if (table) {
    await sql.unsafe(`DELETE FROM "${table}" WHERE repository_id = $1`, [
      repoId,
    ])
  }
  await sql`DELETE FROM user_repository WHERE repository_id = ${repoId}`
  await sql`DELETE FROM repository WHERE id = ${repoId}`

  return c.json({ success: true })
})
