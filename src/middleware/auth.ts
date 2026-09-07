import type { Context, Next } from 'hono'
import { jwt } from 'hono/jwt'
import { hashConnectorKey } from '../db/connectorKeys.js'
import { getStore } from '../db/store.js'
import type { Bindings } from '../types.js'

export const authMiddleware = (c: Context, next: Next) => {
  const env = c.env as Bindings
  return jwt({ secret: env.JWT_SECRET, alg: 'HS256' })(c, next)
}

export const requireAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { role?: string }
  if (payload?.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}

/** Reserved for the super admin: managing other admins. A "normal" admin
 *  (created from the UI) does operational work but not this. */
export const requireSuperAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { role?: string; is_super?: boolean }
  if (payload?.role !== 'admin' || payload?.is_super !== true) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}

/**
 * Connector auth: an API key, not a JWT — these are non-interactive scripts
 * (cron, GitHub Actions), not user sessions. The key travels in
 * `Authorization: Bearer <key>`, like a JWT, to keep the same convention on the
 * caller side.
 */
export const connectorAuth = async (c: Context, next: Next) => {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const env = c.env as Bindings
  const store = await getStore(env.DATABASE_URL)
  const keyHash = await hashConnectorKey(token)
  const key = await store.findConnectorKeyByHash(keyHash)
  if (!key) return c.json({ error: 'Unauthorized' }, 401)

  c.set('connectorKey', key)
  // Best-effort: must never fail the request it accompanies.
  store.touchConnectorKeyUsage(key.id).catch(() => {})
  await next()
}

/** A key only acts on its own provider: the `rss` key cannot write for
 *  `youtube`. Apply after `connectorAuth`. */
export const requireOwnProvider = async (c: Context, next: Next) => {
  const key = c.get('connectorKey') as { provider: string } | undefined
  const provider = c.req.param('provider')
  if (!key || key.provider !== provider) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}

/**
 * Access to `/ui/repositories/*` for an admin (JWT) OR a connector key —
 * without which a connector that manages its own fluxes (e.g. `scrap`/admin.py)
 * would need a real admin account (email + password) just for that, a far
 * broader credential that cannot be revoked without changing the password.
 * A connector key stays scoped to its provider: see `providerScope`, to apply
 * in each route to restrict access to that provider's repositories only.
 */
export const requireAdminOrOwnProviderKey = async (c: Context, next: Next) => {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (token.startsWith('stayup_conn_')) {
    const env = c.env as Bindings
    const store = await getStore(env.DATABASE_URL)
    const keyHash = await hashConnectorKey(token)
    const key = await store.findConnectorKeyByHash(keyHash)
    if (!key) return c.json({ error: 'Unauthorized' }, 401)
    c.set('connectorKey', key)
    store.touchConnectorKeyUsage(key.id).catch(() => {})
    await next()
    return
  }

  return authMiddleware(c, async () => {
    const forbidden = await requireAdmin(c, next)
    if (forbidden) c.res = forbidden
  })
}

/** `null` = admin JWT, full access. A string = connector key, access restricted
 *  to that provider's repositories. Call after `requireAdminOrOwnProviderKey`. */
export const providerScope = (c: Context): string | null => {
  const key = c.get('connectorKey') as { provider: string } | undefined
  return key?.provider ?? null
}

/**
 * Access to `POST /ui/maintenance/cleanup`: an admin (JWT) OR the bearer of the
 * `CLEANUP_SECRET` secret. The cleanup cron is not a session: it cannot hold a
 * 24 h JWT, hence this long secret, set server-side, sent as
 * `Authorization: Bearer`. Constant-time comparison. If `CLEANUP_SECRET` is not
 * configured, only the admin path stays open.
 */
export const requireAdminOrCleanupSecret = async (c: Context, next: Next) => {
  const env = c.env as Bindings
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (
    env.CLEANUP_SECRET &&
    token &&
    timingSafeEqual(token, env.CLEANUP_SECRET)
  ) {
    await next()
    return
  }

  return authMiddleware(c, async () => {
    const forbidden = await requireAdmin(c, next)
    if (forbidden) c.res = forbidden
  })
}

/** Constant-time comparison of two short strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const requireSelfOrAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { sub?: string; role?: string }
  if (payload?.role === 'admin') {
    await next()
    return
  }
  const userId = c.req.param('userId')
  if (payload?.role === 'user' && payload?.sub === userId) {
    await next()
    return
  }
  return c.json({ error: 'Forbidden' }, 403)
}
