import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const documentationRoute = new Hono<{ Bindings: Bindings }>()

documentationRoute.use('*', authMiddleware)

// GET /documentation — list all docs with subscription status for the current user
documentationRoute.get('/', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub ?? ''
  const sql = getSql(c.env.DATABASE_URL)

  const docs = await sql<
    {
      id: number
      name: string
      url: string
      created_at: string
      is_subscribed: boolean
      current_version: number | null
      last_scraped_at: string | null
    }[]
  >`
    SELECT
      dr.id,
      dr.name,
      dr.url,
      dr.created_at,
      EXISTS (
        SELECT 1 FROM user_doc_registry udr
        WHERE udr.doc_registry_id = dr.id AND udr.user_id = ${userId}
      ) AS is_subscribed,
      cd.version  AS current_version,
      cd.scraped_at AS last_scraped_at
    FROM doc_registry dr
    LEFT JOIN connector_doc cd ON cd.doc_registry_id = dr.id AND cd.is_current = TRUE
    ORDER BY dr.name
  `

  return c.json({ docs })
})

// GET /documentation/:docId — current doc content
documentationRoute.get('/:docId', async (c) => {
  const docId = Number.parseInt(c.req.param('docId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [doc] = await sql<{ id: number; name: string; url: string }[]>`
    SELECT id, name, url FROM doc_registry WHERE id = ${docId}
  `
  if (!doc) return c.json({ error: 'Doc not found' }, 404)

  const [current] = await sql<
    { id: number; content: string; version: number; scraped_at: string }[]
  >`
    SELECT id, content, version, scraped_at
    FROM connector_doc
    WHERE doc_registry_id = ${docId} AND is_current = TRUE
    LIMIT 1
  `

  return c.json({ doc, current: current ?? null })
})

// GET /documentation/:docId/history — version list (no content, metadata only)
documentationRoute.get('/:docId/history', async (c) => {
  const docId = Number.parseInt(c.req.param('docId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [doc] = await sql<{ id: number }[]>`
    SELECT id FROM doc_registry WHERE id = ${docId}
  `
  if (!doc) return c.json({ error: 'Doc not found' }, 404)

  const versions = await sql<
    {
      id: number
      version: number
      is_current: boolean
      scraped_at: string
      archived_at: string | null
      has_diff: boolean
    }[]
  >`
    SELECT
      id,
      version,
      is_current,
      scraped_at,
      archived_at,
      diff IS NOT NULL AS has_diff
    FROM connector_doc
    WHERE doc_registry_id = ${docId}
    ORDER BY version DESC
  `

  return c.json({ versions })
})

// GET /documentation/:docId/diff/:versionId — unified diff for a specific version
documentationRoute.get('/:docId/diff/:versionId', async (c) => {
  const docId = Number.parseInt(c.req.param('docId'), 10)
  const versionId = Number.parseInt(c.req.param('versionId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [entry] = await sql<
    { id: number; version: number; diff: string | null; scraped_at: string }[]
  >`
    SELECT id, version, diff, scraped_at
    FROM connector_doc
    WHERE id = ${versionId} AND doc_registry_id = ${docId}
    LIMIT 1
  `

  if (!entry) return c.json({ error: 'Version not found' }, 404)
  if (!entry.diff) {
    return c.json({ error: 'No diff available for this version' }, 404)
  }

  return c.json({
    version: entry.version,
    diff: entry.diff,
    scraped_at: entry.scraped_at,
  })
})

// POST /documentation/:docId/subscribe — subscribe current user to a doc
documentationRoute.post('/:docId/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const docId = Number.parseInt(c.req.param('docId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [doc] = await sql<{ id: number }[]>`
    SELECT id FROM doc_registry WHERE id = ${docId}
  `
  if (!doc) return c.json({ error: 'Doc not found' }, 404)

  const id = crypto.randomUUID()
  try {
    await sql`
      INSERT INTO user_doc_registry (id, user_id, doc_registry_id)
      VALUES (${id}, ${userId}, ${docId})
    `
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Already subscribed' }, 409)
    }
    throw err
  }

  return c.json({ success: true }, 201)
})

// DELETE /documentation/:docId/subscribe — unsubscribe current user from a doc
documentationRoute.delete('/:docId/subscribe', async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const userId = payload?.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const docId = Number.parseInt(c.req.param('docId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const result = await sql<{ id: string }[]>`
    DELETE FROM user_doc_registry
    WHERE user_id = ${userId} AND doc_registry_id = ${docId}
    RETURNING id
  `

  if (result.length === 0) return c.json({ error: 'Not subscribed' }, 404)

  return c.json({ success: true })
})
