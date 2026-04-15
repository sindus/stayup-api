import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const feedRoute = new Hono<{ Bindings: Bindings }>()

feedRoute.use('*', authMiddleware)

// GET /feed/:username — latest content from each connector for the user's providers
feedRoute.get('/:username', async (c) => {
  const username = c.req.param('username')
  const jwt = c.get('jwtPayload') as { username: string; role: string }

  if (jwt.role !== 'admin' && jwt.username !== username) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const [user] = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE username = ${username}
  `
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const userProviders = await sql<
    { provider_type: string; provider_id: number }[]
  >`
    SELECT provider_type, provider_id FROM user_providers WHERE user_id = ${user.id}
  `

  if (userProviders.length === 0) {
    return c.json({ feed: {} })
  }

  // Group subscribed provider IDs by provider table name
  const byType: Record<string, number[]> = {}
  for (const p of userProviders) {
    byType[p.provider_type] ??= []
    byType[p.provider_type].push(p.provider_id)
  }

  // Discover which provider table each connector_* table references via FK
  const connectorFks = await sql<
    { connector_table: string; provider_table: string; fk_column: string }[]
  >`
    SELECT
      tc.table_name AS connector_table,
      ccu.table_name AS provider_table,
      kcu.column_name AS fk_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
      AND tc.constraint_schema = rc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON rc.unique_constraint_name = ccu.constraint_name
      AND rc.unique_constraint_schema = ccu.constraint_schema
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.constraint_schema = kcu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name LIKE ${'connector_%'}
      AND kcu.column_name IN ('provider_id', 'repository_id')
  `

  const feed: Record<string, unknown[]> = {}

  for (const { connector_table, provider_table, fk_column } of connectorFks) {
    const providerIds = byType[provider_table]
    if (!providerIds || providerIds.length === 0) continue

    // connector_scrap has no datetime column; use executed_at as fallback
    const [dtRow] = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${connector_table}
        AND column_name = 'datetime'
    `
    const orderExpr = dtRow
      ? `COALESCE(datetime, executed_at)`
      : `executed_at`

    const rows = await sql.unsafe(
      `SELECT DISTINCT ON ("${fk_column}") *
       FROM "${connector_table}"
       WHERE "${fk_column}" = ANY($1)
       ORDER BY "${fk_column}", ${orderExpr} DESC`,
      [providerIds],
    )

    const connectorName = connector_table.replace(/^connector_/, '')
    feed[connectorName] = rows
  }

  return c.json({ feed })
})
