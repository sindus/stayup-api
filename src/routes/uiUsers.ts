import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import type { DataStore } from '../db/port.js'
import { listProviders } from '../db/providers.js'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
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

async function getFeedForUser(
  store: DataStore,
  userId: string,
): Promise<{
  repositories: UserRepo[]
  connectors: Record<string, unknown[]>
}> {
  const repositories = await store.listSubscriptions(userId)
  const providers = await listProviders(store)

  if (repositories.length === 0) {
    return {
      repositories: [],
      connectors: Object.fromEntries(providers.map((p) => [p.name, []])),
    }
  }

  const repoIds = repositories.map((r) => r.repository_id)
  const entries = await Promise.all(
    providers.map(
      async (p) =>
        [p.name, await store.latestForSources(p.name, repoIds, 10)] as const,
    ),
  )

  return { repositories, connectors: Object.fromEntries(entries) }
}

// ─── Admin-only: user management ────────────────────────────────────────────

// GET /ui/users — list all users
uiUsersRoute.get('/', requireAdmin, async (c) => {
  const users = await (await getStore(c.env.DATABASE_URL)).listUsers()
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

  const store = await getStore(c.env.DATABASE_URL)
  const created = await store.createCredentialUser({
    name: body.name,
    email: normalizeEmail(body.email),
    passwordHash: await hash(body.password, 10),
  })

  if (!created) {
    return c.json({ error: 'Email already in use' }, 409)
  }

  return c.json(
    { user: { id: created.id, name: body.name, email: body.email } },
    201,
  )
})

// GET /ui/users/:userId — get user profile (self or admin)
uiUsersRoute.get('/:userId', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const user = await (await getStore(c.env.DATABASE_URL)).getUser(userId)

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
    currentPassword?: string
  }>()

  const store = await getStore(c.env.DATABASE_URL)
  const isAdmin = (c.get('jwtPayload') as { role?: string })?.role === 'admin'

  // Contrôle en amont : un body ne contenant que `password` doit aussi 404
  if (!(await store.userExists(userId))) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Changer son propre mot de passe exige de connaître l'actuel : sinon un token
  // volé suffit à verrouiller le compte de son propriétaire. Un admin garde la
  // réinitialisation sans preuve, c'est le sens de son rôle.
  if (body.password && !isAdmin) {
    if (!body.currentPassword) {
      return c.json({ error: 'currentPassword is required' }, 400)
    }
    const currentHash = await store.getCredentialHash(userId)
    if (!currentHash) {
      return c.json({ error: 'No password set for this account' }, 409)
    }
    if (!(await compare(body.currentPassword, currentHash))) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }
  }

  if (body.name !== undefined || body.email !== undefined) {
    const name: string | null = body.name ?? null
    const email: string | null =
      body.email === undefined ? null : normalizeEmail(body.email)
    try {
      // L'adaptateur garde `account.account_id` aligné sur la nouvelle adresse.
      await store.updateUser(userId, {
        name: name ?? undefined,
        email: email ?? undefined,
      })
    } catch (err) {
      // Sans ça, un e-mail déjà pris remonte en 500 au lieu d'un conflit lisible.
      if ((err as { code?: string }).code === '23505') {
        return c.json({ error: 'Email already in use' }, 409)
      }
      throw err
    }
  }

  if (body.password) {
    await store.updateCredentialPassword(userId, await hash(body.password, 10))
  }

  return c.json({ success: true })
})

// DELETE /ui/users/:userId — delete a user
uiUsersRoute.delete('/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const deleted = await (await getStore(c.env.DATABASE_URL)).deleteUser(userId)

  if (!deleted) return c.json({ error: 'User not found' }, 404)

  return c.json({ success: true })
})

// ─── User (self or admin): feed & repositories ───────────────────────────────

// GET /ui/users/:userId/feed
uiUsersRoute.get('/:userId/feed', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const data = await getFeedForUser(await getStore(c.env.DATABASE_URL), userId)
  return c.json(data)
})

// GET /ui/users/:userId/feed/:connector
uiUsersRoute.get('/:userId/feed/:connector', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const connector = c.req.param('connector') as string
  const store = await getStore(c.env.DATABASE_URL)

  if (!(await store.providerExists(connector))) {
    return c.json({ error: 'Unknown connector' }, 404)
  }

  const repoIds = await store.listSubscribedSourceIds(userId, connector)
  const data = await store.latestForSources(connector, repoIds, 10)

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

  const jwtPayload = c.get('jwtPayload') as { role?: string }
  if (body.provider === 'scrap' && jwtPayload?.role !== 'admin') {
    return c.json({ error: 'Scrap feeds are managed by admins' }, 403)
  }

  const store = await getStore(c.env.DATABASE_URL)

  // `repository` est partagée par tous les abonnés d'une même URL. Un ON CONFLICT
  // qui écrase `type`/`config` laissait n'importe quel utilisateur convertir le
  // dépôt d'autrui (un changelog devenait un rss, ses abonnés perdaient leur flux,
  // et les lignes connector_* orphelines cassaient ensuite sa suppression). On ne
  // touche donc jamais à une ligne existante : on la réutilise, ou on refuse si
  // elle appartient à un autre provider.
  const existing = await store.findSourceByUrl(body.url)

  if (existing && existing.type !== body.provider) {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }

  const repo =
    existing ??
    (await store.createSource({
      url: body.url,
      type: body.provider,
      config: body.config,
    }))

  const link = await store.subscribe(userId, repo.id)
  if (!link) return c.json({ error: 'Already subscribed' }, 409)

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
})

async function purgeRepository(
  store: DataStore,
  repositoryId: number,
  type: string,
): Promise<void> {
  await store.deleteContentForSource(type, repositoryId)
  await store.deleteSubscriptionsForSource(repositoryId)
  await store.deleteSource(repositoryId)
}

// DELETE /ui/users/:userId/repositories/:linkId
uiUsersRoute.delete(
  '/:userId/repositories/:linkId',
  requireSelfOrAdmin,
  async (c) => {
    const userId = c.req.param('userId') as string
    const linkId = c.req.param('linkId') as string
    const store = await getStore(c.env.DATABASE_URL)
    const link = await store.findSubscription(linkId, userId)

    if (!link) return c.json({ error: 'Feed not found' }, 404)

    const payload = c.get('jwtPayload') as { role?: string }
    const isAdmin = payload?.role === 'admin'

    // Scrap repos are admin-managed: never cascade-delete, just remove the subscription
    if (link.type === 'scrap') {
      await store.unsubscribeById(linkId)
    } else if (isAdmin) {
      await purgeRepository(store, link.repository_id, link.type)
    } else {
      await store.unsubscribeById(linkId)
      if ((await store.countSubscribers(link.repository_id)) === 0) {
        await purgeRepository(store, link.repository_id, link.type)
      }
    }

    return c.json({ success: true })
  },
)
