import { hash } from 'bcryptjs'
import { Hono } from 'hono'
import type postgres from 'postgres'
import { getSql } from '../db/client.js'
import {
  authMiddleware,
  requireAdmin,
  requireSelfOrAdmin,
} from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const uiUsersRoute = new Hono<{ Bindings: Bindings }>()

uiUsersRoute.use('*', authMiddleware)

type UserRepo = {
  id: string
  repository_id: number
  created_at: string
  url: string
  provider: string
  config: Record<string, unknown>
}

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

async function getFeedForUser(
  sql: postgres.Sql,
  userId: string,
): Promise<{
  repositories: UserRepo[]
  connectors: Record<string, unknown[]>
}> {
  const repositories = await sql<UserRepo[]>`
    SELECT
      ur.id,
      ur.repository_id,
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
    return {
      repositories: [],
      connectors: { changelog: [], youtube: [], rss: [], scrap: [] },
    }
  }

  const repoIds = repositories.map((r) => r.repository_id)

  const [changelog, youtube, rss, scrap] = await Promise.all([
    getLatestItemsForRepos(sql, 'connector_changelog', repoIds),
    getLatestItemsForRepos(sql, 'connector_youtube', repoIds),
    getLatestItemsForRepos(sql, 'connector_rss', repoIds),
    getLatestItemsForRepos(sql, 'connector_scrap', repoIds),
  ])

  return { repositories, connectors: { changelog, youtube, rss, scrap } }
}

// ─── Admin-only: user management ────────────────────────────────────────────

// GET /ui/users — list all users
uiUsersRoute.get('/', requireAdmin, async (c) => {
  const sql = getSql(c.env.DATABASE_URL)
  const users = await sql<
    { id: string; name: string; email: string; created_at: string }[]
  >`
    SELECT id, name, email, created_at FROM "user" ORDER BY created_at
  `
  return c.json({ users })
})

// POST /ui/users — create a user
uiUsersRoute.post('/', requireAdmin, async (c) => {
  const body = await c.req.json<{
    name: string
    email: string
    password: string
  }>()

  if (!body.name || !body.email || !body.password) {
    return c.json({ error: 'name, email and password are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)
  const passwordHash = await hash(body.password, 10)
  const userId = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    await sql`
      INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
      VALUES (${userId}, ${body.name}, ${body.email}, ${now}, ${now}, false)
    `
    await sql`
      INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
      VALUES (
        ${accountId},
        ${userId},
        'credential',
        ${body.email},
        ${passwordHash},
        ${now},
        ${now}
      )
    `
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Email already in use' }, 409)
    }
    throw err
  }

  return c.json(
    { user: { id: userId, name: body.name, email: body.email } },
    201,
  )
})

// GET /ui/users/:userId — get user profile (self or admin)
uiUsersRoute.get('/:userId', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const sql = getSql(c.env.DATABASE_URL)

  const [user] = await sql<
    { id: string; name: string; email: string; created_at: string }[]
  >`
    SELECT id, name, email, created_at FROM "user" WHERE id = ${userId}
  `

  if (!user) return c.json({ error: 'User not found' }, 404)

  return c.json({ user })
})

// PATCH /ui/users/:userId — update a user (self or admin)
uiUsersRoute.patch('/:userId', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const body = await c.req.json<{
    name?: string
    email?: string
    password?: string
  }>()

  const sql = getSql(c.env.DATABASE_URL)
  const now = new Date().toISOString()

  if (body.name !== undefined || body.email !== undefined) {
    const name: string | null = body.name ?? null
    const email: string | null = body.email ?? null
    const result = await sql<{ id: string }[]>`
      UPDATE "user"
      SET
        name       = COALESCE(${name}, name),
        email      = COALESCE(${email}, email),
        updated_at = ${now}
      WHERE id = ${userId}
      RETURNING id
    `
    if (result.length === 0) return c.json({ error: 'User not found' }, 404)
  }

  if (body.password) {
    const passwordHash = await hash(body.password, 10)
    await sql`
      UPDATE account
      SET password = ${passwordHash}, updated_at = ${now}
      WHERE user_id = ${userId} AND provider_id = 'credential'
    `
  }

  return c.json({ success: true })
})

// DELETE /ui/users/:userId — delete a user
uiUsersRoute.delete('/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const sql = getSql(c.env.DATABASE_URL)

  const result = await sql<{ id: string }[]>`
    DELETE FROM "user" WHERE id = ${userId} RETURNING id
  `

  if (result.length === 0) return c.json({ error: 'User not found' }, 404)

  return c.json({ success: true })
})

// ─── User (self or admin): feed & repositories ───────────────────────────────

// GET /ui/users/:userId/feed
uiUsersRoute.get('/:userId/feed', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const sql = getSql(c.env.DATABASE_URL)
  const data = await getFeedForUser(sql, userId)
  return c.json(data)
})

// GET /ui/users/:userId/feed/:connector
uiUsersRoute.get('/:userId/feed/:connector', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const connector = c.req.param('connector') as string

  const allowedTables: Record<string, string> = {
    changelog: 'connector_changelog',
    youtube: 'connector_youtube',
    rss: 'connector_rss',
    scrap: 'connector_scrap',
  }

  const table = allowedTables[connector]
  if (!table) return c.json({ error: 'Unknown connector' }, 404)

  const sql = getSql(c.env.DATABASE_URL)

  const repositories = await sql<{ repository_id: number }[]>`
    SELECT ur.repository_id
    FROM user_repository ur
    JOIN repository r ON r.id = ur.repository_id
    WHERE ur.user_id = ${userId} AND r.type = ${connector}
  `

  const repoIds = repositories.map(
    (r: { repository_id: number }) => r.repository_id,
  )
  const data = await getLatestItemsForRepos(sql, table, repoIds)

  return c.json({ connector, data })
})

// POST /ui/users/:userId/repositories
uiUsersRoute.post('/:userId/repositories', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const body = await c.req.json<{
    provider: string
    url: string
    config: Record<string, unknown>
  }>()

  if (!body.provider || !body.url) {
    return c.json({ error: 'provider and url are required' }, 400)
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
        created_at: string
      }[]
    >`
      INSERT INTO user_repository (id, user_id, repository_id)
      VALUES (${linkId}, ${userId}, ${repo.id})
      RETURNING id, repository_id, created_at
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

const connectorTable: Record<string, string> = {
  changelog: 'connector_changelog',
  youtube: 'connector_youtube',
  rss: 'connector_rss',
  scrap: 'connector_scrap',
}

async function purgeRepository(
  sql: postgres.Sql,
  repositoryId: number,
  type: string,
): Promise<void> {
  const table = connectorTable[type]
  if (table) {
    await sql.unsafe(`DELETE FROM "${table}" WHERE repository_id = $1`, [
      repositoryId,
    ])
  }
  await sql`DELETE FROM user_repository WHERE repository_id = ${repositoryId}`
  await sql`DELETE FROM repository WHERE id = ${repositoryId}`
}

// DELETE /ui/users/:userId/repositories/:linkId
uiUsersRoute.delete(
  '/:userId/repositories/:linkId',
  requireSelfOrAdmin,
  async (c) => {
    const userId = c.req.param('userId') as string
    const linkId = c.req.param('linkId') as string
    const sql = getSql(c.env.DATABASE_URL)

    const [link] = await sql<{ repository_id: number; type: string }[]>`
      SELECT ur.repository_id, r.type
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.id = ${linkId} AND ur.user_id = ${userId}
    `

    if (!link) return c.json({ error: 'Flux introuvable' }, 404)

    const payload = c.get('jwtPayload') as { role?: string }
    const isAdmin = payload?.role === 'admin'

    if (isAdmin) {
      await purgeRepository(sql, link.repository_id, link.type)
    } else {
      await sql`DELETE FROM user_repository WHERE id = ${linkId}`
      const [{ count }] = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM user_repository
        WHERE repository_id = ${link.repository_id}
      `
      if (Number.parseInt(count, 10) === 0) {
        await purgeRepository(sql, link.repository_id, link.type)
      }
    }

    return c.json({ success: true })
  },
)
