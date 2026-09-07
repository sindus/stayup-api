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
  /** Set for a subscription to a flux from a secondary database. */
  data_source_id?: number
  data_source_name?: string
}

/** Link id for an external subscription, carried by the feed and recognized by
 *  the subscription DELETE (secondary databases have no link id shared with the
 *  primary one). */
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

  // Local content, one key per provider.
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

  // Secondary databases' content: resolved by URL, then tagged by database.
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
// Declared before `/:userId` so the static segment wins over the parameter.

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
    // The e-mail was taken in the meantime (by another approved sign-up).
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

  // Upfront check: a body containing only `password` must 404 too
  if (!(await store.userExists(userId))) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Changing your own password requires knowing the current one: otherwise a
  // stolen token is enough to lock the owner out of their account. An admin
  // keeps proof-free reset — that is the point of the role.
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
      // The adapter keeps `account.account_id` aligned with the new address.
      await store.updateUser(userId, {
        name: name ?? undefined,
        email: email ?? undefined,
      })
    } catch (err) {
      // Without this, an already-taken e-mail surfaces as a 500 instead of a
      // readable conflict.
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

  // `repository` is shared by every subscriber of the same URL. An ON CONFLICT
  // that overwrote `type`/`config` let any user convert someone else's
  // repository (a changelog became an rss, its subscribers lost their flux, and
  // the orphaned connector_* rows then broke its deletion). So we never touch an
  // existing row: we reuse it, or refuse if it belongs to another provider.
  const existing = await store.findSourceByUrl(body.url)

  if (existing && existing.type !== body.provider) {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }

  // A brand-new flux for a provider in `manual` mode goes through the approval
  // queue — unless an admin is acting, or the flux already exists (already
  // checked: subscribing to it needs no approval).
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

// DELETE /ui/users/:userId/repositories/:linkId
uiUsersRoute.delete(
  '/:userId/repositories/:linkId',
  requireSelfOrAdmin,
  async (c) => {
    const userId = c.req.param('userId') as string
    const linkId = c.req.param('linkId') as string
    const store = await getStore(c.env.DATABASE_URL)

    // Subscription to a flux from a secondary database: identified by
    // (database, URL), not by a local link id. We just unsubscribe — the
    // database is read-only, nothing to purge.
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

    // Removing a flux from your list = unsubscribing, nothing more. The
    // `repository` source and its `connector_*` content (produced by the
    // collector) are never deleted here: purging as soon as a source has no
    // subscriber destroyed history on a transient state (remove then re-add) and
    // raced the collector still writing into it. Durable deletion of a source
    // stays reserved for the admin endpoints `DELETE /ui/repositories/:id` and
    // `/ui/repositories/:id/data`.
    await store.unsubscribeById(linkId)

    return c.json({ success: true })
  },
)
