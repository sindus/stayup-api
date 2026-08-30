import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import type { DataStore } from '../db/port.js'
import { listProviders } from '../db/providers.js'
import { getStore, openSecondaryStores } from '../db/store.js'
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
  /** Renseigné pour un abonnement à un flux d'une base secondaire. */
  data_source_id?: number
  data_source_name?: string
}

/** Identifiant de lien d'un abonnement externe, transporté par le feed et
 *  reconnu par le DELETE d'abonnement (les bases secondaires n'ont pas d'id de
 *  lien commun avec la principale). */
function externalLinkId(dataSourceId: number, url: string): string {
  return `ext:${dataSourceId}:${encodeURIComponent(url)}`
}

export function parseExternalLinkId(
  linkId: string,
): { dataSourceId: number; url: string } | null {
  const m = linkId.match(/^ext:(\d+):(.+)$/)
  if (!m) return null
  return { dataSourceId: Number(m[1]), url: decodeURIComponent(m[2]) }
}

async function getFeedForUser(
  store: DataStore,
  userId: string,
  env: Bindings,
): Promise<{
  repositories: UserRepo[]
  connectors: Record<string, unknown[]>
}> {
  const [localSubs, providers, external] = await Promise.all([
    store.listSubscriptions(userId),
    listProviders(store),
    store.listExternalSubscriptions(userId),
  ])

  // Contenu local, une clé par provider.
  const connectors: Record<string, unknown[]> = Object.fromEntries(
    providers.map((p) => [p.name, [] as unknown[]]),
  )
  const localIds = localSubs.map((r) => r.repository_id)
  if (localIds.length > 0) {
    await Promise.all(
      providers.map(async (p) => {
        connectors[p.name] = await store.latestForSources(p.name, localIds, 10)
      }),
    )
  }

  // Contenu des bases secondaires : résolu par URL, puis tagué par base.
  const extRepos: UserRepo[] = []
  if (external.length > 0) {
    const secondaries = await openSecondaryStores(store, env.JWT_SECRET)
    for (const s of secondaries) {
      const subs = external.filter((e) => e.data_source_id === s.id)
      if (subs.length === 0) continue

      const byProvider = new Map<string, string[]>()
      for (const sub of subs) {
        const list = byProvider.get(sub.provider) ?? []
        list.push(sub.source_url)
        byProvider.set(sub.provider, list)
      }

      for (const [provider, urls] of byProvider) {
        const sources = await s.store
          .listSourcesOfType(provider, userId)
          .catch(() => [])
        const idByUrl = new Map(sources.map((r) => [r.url, r.id]))
        const ids = urls
          .map((u) => idByUrl.get(u))
          .filter((v): v is number => typeof v === 'number')

        const rows =
          ids.length > 0
            ? await s.store.latestForSources(provider, ids, 10)
            : []
        connectors[provider] = [
          ...(connectors[provider] ?? []),
          ...rows.map((r) => ({
            ...(r as Record<string, unknown>),
            _data_source_id: s.id,
            _data_source_name: s.name,
          })),
        ]

        for (const url of urls) {
          extRepos.push({
            id: externalLinkId(s.id, url),
            repository_id: 0,
            created_at: '',
            url,
            provider,
            config: {},
            data_source_id: s.id,
            data_source_name: s.name,
          })
        }
      }
    }
  }

  return { repositories: [...localSubs, ...extRepos], connectors }
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

// ─── Admin-only: pending sign-ups (REGISTRATION_MODE=approval) ──────────────
// Déclaré avant `/:userId` pour que le segment statique gagne sur le paramètre.

// GET /ui/users/pending — list accounts awaiting approval
uiUsersRoute.get('/pending', requireAdmin, async (c) => {
  const rows = await (await getStore(c.env.DATABASE_URL)).listPendingUsers()
  return c.json({
    users: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      method: r.oauth_provider ?? 'password',
      created_at: r.created_at,
    })),
  })
})

// POST /ui/users/pending/:id/approve — activate the account
uiUsersRoute.post('/pending/:id/approve', requireAdmin, async (c) => {
  const id = c.req.param('id') as string
  const store = await getStore(c.env.DATABASE_URL)
  const pending = await store.getPendingUser(id)
  if (!pending) return c.json({ error: 'Pending user not found' }, 404)

  let created: { id: string } | null = null
  if (pending.password_hash) {
    created = await store.createCredentialUser({
      name: pending.name,
      email: pending.email,
      passwordHash: pending.password_hash,
    })
  } else if (pending.oauth_provider && pending.oauth_account_id) {
    const user = await store.createOAuthUser({
      name: pending.name,
      email: pending.email,
      emailVerified: !pending.email.endsWith('@users.noreply.stayup'),
    })
    await store.linkOAuthAccount(
      user.id,
      pending.oauth_provider,
      pending.oauth_account_id,
    )
    created = { id: user.id }
  }

  if (!created) {
    // L'e-mail a été pris entre-temps (par une autre inscription validée).
    return c.json({ error: 'Email already in use' }, 409)
  }

  await store.deletePendingUser(id)
  return c.json(
    { user: { id: created.id, name: pending.name, email: pending.email } },
    201,
  )
})

// POST /ui/users/pending/:id/reject — drop the request
uiUsersRoute.post('/pending/:id/reject', requireAdmin, async (c) => {
  const deleted = await (await getStore(c.env.DATABASE_URL)).deletePendingUser(
    c.req.param('id') as string,
  )
  if (!deleted) return c.json({ error: 'Pending user not found' }, 404)
  return c.json({ success: true })
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
  const data = await getFeedForUser(
    await getStore(c.env.DATABASE_URL),
    userId,
    c.env,
  )
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
  const isAdmin = jwtPayload?.role === 'admin'

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

  // Un flux inédit pour un provider en mode `manual` passe par la file
  // d'approbation — sauf si c'est un admin qui agit, ou si le flux existe déjà
  // (déjà vérifié : s'y abonner ne demande pas d'approbation).
  if (!existing && !isAdmin) {
    const [meta] = await store.readRegistry([body.provider])
    if (meta?.flux_approval === 'manual') {
      const pending = await store.findPendingFluxRequest(
        userId,
        body.provider,
        body.url,
      )
      if (pending) {
        return c.json(
          { error: 'A pending request already exists for this flux' },
          409,
        )
      }
      const request = await store.createFluxRequest(
        userId,
        body.provider,
        body.url,
      )
      return c.json({ status: 'pending', request }, 202)
    }
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

    // Abonnement à un flux d'une base secondaire : identifié par (base, URL), pas
    // par un id de lien local. On se contente de désabonner — la base est en
    // lecture seule, rien à purger.
    const ext = parseExternalLinkId(linkId)
    if (ext) {
      const removed = await store.unsubscribeExternal(
        userId,
        ext.dataSourceId,
        ext.url,
      )
      if (!removed) return c.json({ error: 'Feed not found' }, 404)
      return c.json({ success: true })
    }

    const link = await store.findSubscription(linkId, userId)

    if (!link) return c.json({ error: 'Feed not found' }, 404)

    const payload = c.get('jwtPayload') as { role?: string }
    const isAdmin = payload?.role === 'admin'

    // Les flux d'un provider en mode `manual` sont curés : ils ont d'autres
    // abonnés et une gestion admin dédiée — ici on se contente de désabonner,
    // jamais de purger la source (même pour un admin).
    const [meta] = await store.readRegistry([link.type])
    const curated = meta?.flux_approval === 'manual'

    if (curated) {
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
