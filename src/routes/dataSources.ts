import { Hono } from 'hono'
import { encryptSecret } from '../db/secretbox.js'
import { engineOf, getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

/**
 * Management of secondary databases (admin). A secondary database is read-only:
 * the API only aggregates its `connector_*` content into feeds. Its connection
 * string is encrypted at rest (see db/secretbox.ts) and is never returned — only
 * the host is.
 */
export const dataSourcesRoute = new Hono<{ Bindings: Bindings }>()

dataSourcesRoute.use('*', authMiddleware, requireAdmin)

/** Readable host of a connection URL, without credentials. */
function dbHost(url: string): string {
  try {
    const u = new URL(url)
    // `URL.host` = hostname:port, never the credentials.
    return u.host || u.pathname.replace(/^\/+/, '') || url
  } catch {
    return url.replace(/^[a-z0-9+]+:(\/\/)?/i, '').split(/[?#]/)[0]
  }
}

/** Opens the URL and returns the connectors it exposes, without saving anything. */
async function probe(
  url: string,
): Promise<
  | { ok: true; engine: string; connectors: string[] }
  | { ok: false; error: string }
> {
  const engine = engineOf(url)
  if (!engine) return { ok: false, error: 'Unsupported database URL scheme' }
  try {
    const store = await getStore(url)
    const connectors = await store.listProviderNames()
    return { ok: true, engine, connectors }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// GET /ui/data-sources — the primary database (info) + the secondary databases.
dataSourcesRoute.get('/', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const rows = await store.listDataSources()
  const { decryptSecret } = await import('../db/secretbox.js')

  const sources = await Promise.all(
    rows.map(async (r) => {
      let host = '(unavailable)'
      try {
        host = dbHost(await decryptSecret(r.url_enc, c.env.JWT_SECRET))
      } catch {
        // encryption key changed, or corrupted blob — we expose it anyway.
      }
      return {
        id: r.id,
        name: r.name,
        engine: r.engine,
        host,
        created_at: r.created_at,
      }
    }),
  )

  return c.json({
    primary: {
      engine: engineOf(c.env.DATABASE_URL) ?? 'unknown',
      host: dbHost(c.env.DATABASE_URL),
    },
    sources,
  })
})

// POST /ui/data-sources/test — tests a URL without saving it.
dataSourcesRoute.post('/test', async (c) => {
  const body = await c.req.json<{ url?: string }>()
  if (!body.url) return c.json({ error: 'url is required' }, 400)
  return c.json(await probe(body.url.trim()))
})

// POST /ui/data-sources — tests then saves (encrypted).
dataSourcesRoute.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; url?: string }>()
  if (!body.name || !body.url) {
    return c.json({ error: 'name and url are required' }, 400)
  }

  const url = body.url.trim()
  const result = await probe(url)
  if (!result.ok) return c.json({ error: result.error }, 400)
  if (result.connectors.length === 0) {
    return c.json({ error: 'No connector_* table found in that database' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const created = await store.createDataSource({
    name: body.name.trim(),
    engine: result.engine,
    urlEnc: await encryptSecret(url, c.env.JWT_SECRET),
  })

  return c.json(
    {
      dataSource: {
        id: created.id,
        name: body.name.trim(),
        engine: result.engine,
        host: dbHost(url),
        connectors: result.connectors,
      },
    },
    201,
  )
})

// DELETE /ui/data-sources/:id — removes the database (and its external subscriptions).
dataSourcesRoute.delete('/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Data source not found' }, 404)

  const removed = await (await getStore(c.env.DATABASE_URL)).deleteDataSource(
    id,
  )
  if (!removed) return c.json({ error: 'Data source not found' }, 404)
  return c.json({ success: true })
})
