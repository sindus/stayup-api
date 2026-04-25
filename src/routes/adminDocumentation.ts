import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const adminDocumentationRoute = new Hono<{ Bindings: Bindings }>()

adminDocumentationRoute.use('*', authMiddleware)
adminDocumentationRoute.use('*', requireAdmin)

// GET /ui/doc-registry — list all doc registries with subscriber count
adminDocumentationRoute.get('/', async (c) => {
  const sql = getSql(c.env.DATABASE_URL)

  const rows = await sql<
    {
      id: number
      name: string
      url: string
      config: Record<string, unknown>
      created_at: string
      subscriber_count: string
      current_version: number | null
      last_scraped_at: string | null
    }[]
  >`
    SELECT
      dr.id,
      dr.name,
      dr.url,
      dr.config,
      dr.created_at,
      COUNT(udr.id)::text AS subscriber_count,
      cd.version           AS current_version,
      cd.scraped_at        AS last_scraped_at
    FROM doc_registry dr
    LEFT JOIN user_doc_registry udr ON udr.doc_registry_id = dr.id
    LEFT JOIN connector_doc cd ON cd.doc_registry_id = dr.id AND cd.is_current = TRUE
    GROUP BY dr.id, cd.version, cd.scraped_at
    ORDER BY dr.id
  `

  return c.json({ registries: rows })
})

// POST /ui/doc-registry — add a new doc registry entry
adminDocumentationRoute.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    url: string
    config: Record<string, unknown>
  }>()

  if (!body.name || !body.url) {
    return c.json({ error: 'name and url are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)

  try {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO doc_registry (name, url, config)
      VALUES (${body.name}, ${body.url}, ${JSON.stringify(body.config ?? {})}::jsonb)
      ON CONFLICT (name) DO UPDATE SET
        url    = EXCLUDED.url,
        config = EXCLUDED.config
      RETURNING id
    `
    return c.json({ id: row.id, name: body.name, url: body.url }, 201)
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'A doc with this name already exists' }, 409)
    }
    throw err
  }
})

// DELETE /ui/doc-registry/:docId — full purge (connector data + subscriptions + registry)
adminDocumentationRoute.delete('/:docId', async (c) => {
  const docId = Number.parseInt(c.req.param('docId'), 10)
  const sql = getSql(c.env.DATABASE_URL)

  const [doc] = await sql<{ id: number }[]>`
    SELECT id FROM doc_registry WHERE id = ${docId}
  `
  if (!doc) return c.json({ error: 'Doc registry not found' }, 404)

  await sql`DELETE FROM connector_doc WHERE doc_registry_id = ${docId}`
  await sql`DELETE FROM user_doc_registry WHERE doc_registry_id = ${docId}`
  await sql`DELETE FROM doc_registry WHERE id = ${docId}`

  return c.json({ success: true })
})
