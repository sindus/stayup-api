import { Hono } from 'hono'
import type postgres from 'postgres'
import { getSql } from '../db/client.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const uiUsersRoute = new Hono<{ Bindings: Bindings }>()

uiUsersRoute.use('*', authMiddleware)
uiUsersRoute.use('*', requireAdmin)

type UserRepo = {
  id: string
  repository_id: number
  label: string
  created_at: string
  url: string
  provider: string
  config: Record<string, unknown>
}

// Returns the last `limit` items per repository_id from a connector table.
async function getLatestItemsForRepos(
  sql: postgres.Sql,
  table: string,
  repoIds: number[],
  limit = 10,
): Promise<unknown[]> {
  if (repoIds.length === 0) return []
  try {
    return await sql.unsafe(
      `SELECT * FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY repository_id ORDER BY executed_at DESC
          ) AS _rn
        FROM "${table}"
        WHERE repository_id = ANY($1)
      ) ranked
      WHERE _rn <= ${limit}
      ORDER BY repository_id, executed_at DESC`,
      [repoIds],
    )
  } catch {
    return []
  }
}

// GET /ui/users/:userId/feed
// Returns the user's subscribed repositories and their latest connector items.
// Admin-only — called by the UI server with its service-account JWT.
uiUsersRoute.get('/:userId/feed', async (c) => {
  const userId = c.req.param('userId')
  const sql = getSql(c.env.DATABASE_URL)

  const repositories = await sql<UserRepo[]>`
    SELECT
      ur.id,
      ur.repository_id,
      ur.label,
      ur.created_at,
      r.url,
      r.type  AS provider,
      r.config
    FROM user_repository ur
    JOIN repository r ON r.id = ur.repository_id
    WHERE ur.user_id = ${userId}
    ORDER BY ur.created_at
  `

  if (repositories.length === 0) {
    return c.json({
      repositories: [],
      connectors: { changelog: [], youtube: [], rss: [], scrap: [] },
    })
  }

  const repoIds = repositories.map((r) => r.repository_id)

  const [changelog, youtube, rss, scrap] = await Promise.all([
    getLatestItemsForRepos(sql, 'connector_changelog', repoIds),
    getLatestItemsForRepos(sql, 'connector_youtube', repoIds),
    getLatestItemsForRepos(sql, 'connector_rss', repoIds),
    getLatestItemsForRepos(sql, 'connector_scrap', repoIds),
  ])

  return c.json({
    repositories,
    connectors: { changelog, youtube, rss, scrap },
  })
})

// POST /ui/users/:userId/repositories
// Upserts a repository row then creates the user_repository link.
uiUsersRoute.post('/:userId/repositories', async (c) => {
  const userId = c.req.param('userId')
  const body = await c.req.json<{
    provider: string
    url: string
    config: Record<string, unknown>
    label: string
  }>()

  if (!body.provider || !body.url || !body.label) {
    return c.json({ error: 'provider, url and label are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const [repo] = await sql<{ id: number }[]>`
    INSERT INTO repository (url, type, config)
    VALUES (${body.url}, ${body.provider}, ${JSON.stringify(body.config)}::jsonb)
    ON CONFLICT (url) DO UPDATE SET
      type   = EXCLUDED.type,
      config = EXCLUDED.config
    RETURNING id
  `

  const linkId = crypto.randomUUID()

  try {
    const [link] = await sql<
      {
        id: string
        repository_id: number
        label: string
        created_at: string
      }[]
    >`
      INSERT INTO user_repository (id, user_id, repository_id, label)
      VALUES (${linkId}, ${userId}, ${repo.id}, ${body.label})
      RETURNING id, repository_id, label, created_at
    `
    return c.json(
      {
        repository: {
          ...link,
          provider: body.provider,
          url: body.url,
          config: body.config,
        },
      },
      201,
    )
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Vous êtes déjà abonné à ce flux' }, 409)
    }
    throw err
  }
})

// DELETE /ui/users/:userId/repositories/:linkId
uiUsersRoute.delete('/:userId/repositories/:linkId', async (c) => {
  const userId = c.req.param('userId')
  const linkId = c.req.param('linkId')
  const sql = getSql(c.env.DATABASE_URL)

  const [deleted] = await sql<{ id: string }[]>`
    DELETE FROM user_repository
    WHERE id = ${linkId} AND user_id = ${userId}
    RETURNING id
  `

  if (!deleted) {
    return c.json({ error: 'Flux introuvable' }, 404)
  }

  return c.json({ success: true })
})
