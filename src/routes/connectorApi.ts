import { Hono } from 'hono'
import type { ContentItemInput } from '../db/port.js'
import { getStore } from '../db/store.js'
import { connectorAuth, requireOwnProvider } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

/**
 * Ce que les connectors appellent — plus jamais la base directement (voir
 * `docs/self-hosting-and-providers.md` Part 2). Authentifié par une clé
 * d'API (`connectorAuth`), scopée à un seul provider (`requireOwnProvider`) :
 * une clé `rss` ne peut agir que sous `/connector-api/rss/*`.
 *
 * Distinct de `/connectors`, qui reste réservé aux 3 apps (JWT utilisateur,
 * lecture seule) — mélanger les deux mécanismes d'auth sous un même préfixe
 * serait une source d'erreurs.
 */
export const connectorApiRoute = new Hono<{ Bindings: Bindings }>()

connectorApiRoute.use('/:provider/*', connectorAuth, requireOwnProvider)

// POST /:provider/register — auto-déclaration au démarrage (nom affiché,
// gabarit d'affichage). Idempotent : à rappeler à chaque run sans risque.
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

// GET /:provider/sources — mes sources suivies (repository + config), pour
// savoir quoi collecter à ce run.
connectorApiRoute.get('/:provider/sources', async (c) => {
  const provider = c.req.param('provider')
  const store = await getStore(c.env.DATABASE_URL)
  const sources = await store.listSourcesForProvider(provider)
  return c.json({
    sources: sources.map((s) => ({ id: s.id, url: s.url, config: s.config })),
  })
})

// GET /:provider/sources/:id/state — dernière version connue pour cette
// source, pour savoir où reprendre (null au premier run).
connectorApiRoute.get('/:provider/sources/:id/state', async (c) => {
  const provider = c.req.param('provider')
  const id = Number.parseInt(c.req.param('id'), 10)
  if (Number.isNaN(id)) return c.json({ error: 'Source not found' }, 404)

  const store = await getStore(c.env.DATABASE_URL)
  const version = await store.getLastKnownVersion(provider, id)
  return c.json({ version })
})

// PATCH /:provider/sources/:id/config — fusionne des clés dans la config
// d'une source (ex. `rss` y range le titre du canal pour l'affichage).
// Fusion, jamais un remplacement : ne touche pas aux clés absentes du corps.
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

// POST /:provider/items — écriture en lot (pas un POST par item, pour éviter
// un aller-retour HTTP par ligne collectée).
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

// POST /:provider/errors — une erreur de collecte, consignée dans `log`.
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
