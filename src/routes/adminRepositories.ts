import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import {
  providerScope,
  requireAdminOrOwnProviderKey,
} from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const adminRepositoriesRoute = new Hono<{ Bindings: Bindings }>()

adminRepositoriesRoute.use('*', requireAdminOrOwnProviderKey)

// POST / — create a new repository (scrap or other types)
adminRepositoriesRoute.post('/', async (c) => {
  const body = await c.req.json<{
    url: string
    type: string
    config: Record<string, unknown>
  }>()

  if (!body.url || !body.type) {
    return c.json({ error: 'url and type are required' }, 400)
  }

  const scope = providerScope(c)
  if (scope !== null && body.type !== scope) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const store = await getStore(c.env.DATABASE_URL)

  // Création explicite par un admin : si l'URL existe déjà, on met à jour sa
  // config, mais jamais son type — le convertir romprait les abonnés existants.
  const existing = await store.findSourceByUrl(body.url)
  if (existing && existing.type !== body.type) {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }

  let repo = existing
  if (repo) {
    await store.updateSourceConfig(repo.id, body.config ?? {})
  } else {
    repo = await store.createSource({
      url: body.url,
      type: body.type,
      config: body.config ?? {},
    })
  }

  return c.json({ id: repo.id, url: body.url, type: body.type }, 201)
})

// PATCH /:repoId — update an existing repository by id, url and/or config.
// Distinct from POST / (upsert by url) : celle-ci cible une ligne existante
// et peut changer son URL en place, ce qu'un upsert-par-url ne permet pas
// (un nouvel URL y créerait une seconde ligne au lieu de renommer la première).
adminRepositoriesRoute.patch('/:repoId', async (c) => {
  const repoId = Number.parseInt(c.req.param('repoId') as string, 10)
  if (Number.isNaN(repoId))
    return c.json({ error: 'Repository not found' }, 404)

  const body = await c.req.json<{
    url?: string
    config?: Record<string, unknown>
  }>()

  const store = await getStore(c.env.DATABASE_URL)
  const repo = await store.getSource(repoId)
  if (!repo) return c.json({ error: 'Repository not found' }, 404)

  const scope = providerScope(c)
  if (scope !== null && repo.type !== scope) {
    return c.json({ error: 'Repository not found' }, 404)
  }

  if (body.url !== undefined && body.url !== repo.url) {
    try {
      await store.updateSourceUrl(repoId, body.url)
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return c.json({ error: 'This URL is already registered' }, 409)
      }
      throw err
    }
  }
  if (body.config !== undefined) {
    await store.updateSourceConfig(repoId, body.config)
  }

  return c.json({ success: true })
})

// GET / — list all repositories with subscriber count
adminRepositoriesRoute.get('/', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const rows = await store.listSourcesWithSubscriberCount()
  const scope = providerScope(c)
  const visible = scope === null ? rows : rows.filter((r) => r.type === scope)
  return c.json({ repositories: visible })
})

// DELETE /:repoId/data — delete connector data only (keep repository + subscriptions)
adminRepositoriesRoute.delete('/:repoId/data', async (c) => {
  const repoId = Number.parseInt(c.req.param('repoId') as string, 10)
  if (Number.isNaN(repoId))
    return c.json({ error: 'Repository not found' }, 404)

  const store = await getStore(c.env.DATABASE_URL)

  const repo = await store.getSource(repoId)
  if (!repo) return c.json({ error: 'Repository not found' }, 404)

  const scope = providerScope(c)
  if (scope !== null && repo.type !== scope) {
    return c.json({ error: 'Repository not found' }, 404)
  }

  await store.deleteContentForSource(repo.type, repoId)

  return c.json({ success: true })
})

// DELETE /:repoId — full purge (connector data + all user subscriptions + repository)
adminRepositoriesRoute.delete('/:repoId', async (c) => {
  const repoId = Number.parseInt(c.req.param('repoId') as string, 10)
  if (Number.isNaN(repoId))
    return c.json({ error: 'Repository not found' }, 404)

  const store = await getStore(c.env.DATABASE_URL)

  const repo = await store.getSource(repoId)
  if (!repo) return c.json({ error: 'Repository not found' }, 404)

  const scope = providerScope(c)
  if (scope !== null && repo.type !== scope) {
    return c.json({ error: 'Repository not found' }, 404)
  }

  await store.deleteContentForSource(repo.type, repoId)
  await store.deleteSubscriptionsForSource(repoId)
  await store.deleteSource(repoId)

  return c.json({ success: true })
})
