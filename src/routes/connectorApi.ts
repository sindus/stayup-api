import { Hono } from 'hono'
import type { ContentItemInput } from '../db/port.js'
import { getStore } from '../db/store.js'
import { connectorAuth, requireOwnProvider } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

/**
 * What connectors call — never the database directly anymore (see
 * `docs/self-hosting-and-providers.md` Part 2). Authenticated by an API key
 * (`connectorAuth`), scoped to a single provider (`requireOwnProvider`): an
 * `rss` key can only act under `/connector-api/rss/*`.
 *
 * Distinct from `/connectors`, which stays reserved for the 3 apps (user JWT,
 * read-only) — mixing the two auth mechanisms under one prefix would be a source
 * of mistakes.
 */
export const connectorApiRoute = new Hono<{ Bindings: Bindings }>()

connectorApiRoute.use('/:provider/*', connectorAuth, requireOwnProvider)

// POST /:provider/register — self-declaration at startup (display name, display
// template). Idempotent: safe to call on every run.
connectorApiRoute.post('/:provider/register', async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{
    displayName?: string
    sortOrder?: number
    template?: unknown
  }>()

  if (!body.displayName) {
    return c.json({ error: 'displayName is required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  await store.registerProvider({
    name: provider,
    displayName: body.displayName,
    sortOrder: body.sortOrder,
    template: body.template,
  })
  return c.json({ success: true })
})

// POST /:provider/sources — follows a new URL (equivalent of a connector's
// `--add` command-line flag). Idempotent on the URL, as before.
connectorApiRoute.post('/:provider/sources', async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ url?: string }>()
  if (!body.url) return c.json({ error: 'url is required' }, 400)

  const store = await getStore(c.env.DATABASE_URL)
  const existing = await store.findSourceByUrl(body.url)
  if (existing && existing.type !== provider) {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }
  const source =
    existing ??
    (await store.createSource({ url: body.url, type: provider, config: {} }))
  return c.json({ id: source.id, url: source.url }, existing ? 200 : 201)
})

// GET /:provider/sources — my tracked sources (repository + config), to know
// what to collect this run.
connectorApiRoute.get('/:provider/sources', async (c) => {
  const provider = c.req.param('provider')
  const store = await getStore(c.env.DATABASE_URL)
  const sources = await store.listSourcesForProvider(provider)
  return c.json({
    sources: sources.map((s) => ({ id: s.id, url: s.url, config: s.config })),
  })
})

// GET /:provider/sources/:id/state — last known version for this source, to
// know where to resume (null on the first run).
connectorApiRoute.get('/:provider/sources/:id/state', async (c) => {
  const provider = c.req.param('provider')
  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Source not found' }, 404)

  const store = await getStore(c.env.DATABASE_URL)
  const version = await store.getLastKnownVersion(provider, id)
  return c.json({ version })
})

// GET /:provider/sources/:id/versions — every version already known for this
// source (not just the latest) — for a connector that must fill gaps rather
// than just resume after the most recent one (e.g. `changelog`, whose GitHub
// releases can show up out of order).
connectorApiRoute.get('/:provider/sources/:id/versions', async (c) => {
  const provider = c.req.param('provider')
  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Source not found' }, 404)

  const store = await getStore(c.env.DATABASE_URL)
  const versions = await store.listKnownVersions(provider, id)
  return c.json({ versions })
})

// PATCH /:provider/sources/:id/config — merges keys into a source's config
// (e.g. `rss` stores the channel title there for display). A merge, never a
// replace: leaves keys absent from the body untouched.
connectorApiRoute.patch('/:provider/sources/:id/config', async (c) => {
  const provider = c.req.param('provider')
  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Source not found' }, 404)

  const body = await c.req.json<{ config?: Record<string, unknown> }>()
  if (typeof body.config !== 'object' || body.config === null) {
    return c.json({ error: 'config is required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const source = await store.getSource(id)
  if (!source || source.type !== provider) {
    return c.json({ error: 'Source not found' }, 404)
  }

  await store.mergeSourceConfig(id, body.config)
  return c.json({ success: true })
})

interface ItemPayload {
  repositoryId: number
  version?: string | null
  content: string
  params?: Record<string, unknown> | null
  datetime?: string | null
  executedAt: string
  success: boolean
}

function isValidItem(item: unknown): item is ItemPayload {
  if (typeof item !== 'object' || item === null) return false
  const i = item as Record<string, unknown>
  return (
    typeof i.repositoryId === 'number' &&
    typeof i.content === 'string' &&
    typeof i.executedAt === 'string' &&
    typeof i.success === 'boolean'
  )
}

// POST /:provider/items — batch write (not one POST per item, to avoid an HTTP
// round-trip per collected row).
connectorApiRoute.post('/:provider/items', async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ items?: unknown[] }>()
  const items = body.items ?? []

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every(isValidItem)
  ) {
    return c.json(
      {
        error:
          'items must be a non-empty array of { repositoryId, content, executedAt, success }',
      },
      400,
    )
  }

  const store = await getStore(c.env.DATABASE_URL)
  await store.insertContentItems(provider, items as ContentItemInput[])
  return c.json({ success: true, count: items.length }, 201)
})

// DELETE /:provider/sources/:id/old-items?retentionDays=N — purges what each
// connector used to do itself after every run. Filtered by `provider` in the
// query itself: an id from another provider deletes nothing.
connectorApiRoute.delete('/:provider/sources/:id/old-items', async (c) => {
  const provider = c.req.param('provider')
  const id = Number.parseInt(c.req.param('id'), 10)
  const retentionDays = Number.parseInt(c.req.query('retentionDays') ?? '', 10)
  if (Number.isNaN(id)) return c.json({ error: 'Source not found' }, 404)
  if (Number.isNaN(retentionDays) || retentionDays < 0) {
    return c.json(
      { error: 'retentionDays must be a non-negative integer' },
      400,
    )
  }

  const store = await getStore(c.env.DATABASE_URL)
  await store.deleteOldContent(provider, id, retentionDays)
  return c.json({ success: true })
})

// POST /:provider/errors — a collection error, recorded in `log`.
connectorApiRoute.post('/:provider/errors', async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{
    repositoryId?: number | null
    error?: string
    executedAt?: string
  }>()

  if (!body.error || !body.executedAt) {
    return c.json({ error: 'error and executedAt are required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  await store.logConnectorError(
    provider,
    body.repositoryId ?? null,
    body.error,
    body.executedAt,
  )
  return c.json({ success: true }, 201)
})
