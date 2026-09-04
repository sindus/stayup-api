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

/** Réservé au super admin : la gestion des autres admins. Un admin « normal »
 *  (créé depuis l'interface) fait l'opérationnel mais pas ça. */
export const requireSuperAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { role?: string; is_super?: boolean }
  if (payload?.role !== 'admin' || payload?.is_super !== true) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}

/**
 * Auth des connectors : une clé d'API, pas un JWT — ce sont des scripts non
 * interactifs (cron, GitHub Actions), pas des sessions utilisateur. La clé
 * voyage en `Authorization: Bearer <clé>`, comme un JWT, pour rester dans la
 * même convention côté appelant.
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
  // Best-effort : ne doit jamais faire échouer la requête qu'il accompagne.
  store.touchConnectorKeyUsage(key.id).catch(() => {})
  await next()
}

/** Une clé n'agit que sur son propre provider : la clé `rss` ne peut pas
 *  écrire pour `youtube`. À poser après `connectorAuth`. */
export const requireOwnProvider = async (c: Context, next: Next) => {
  const key = c.get('connectorKey') as { provider: string } | undefined
  const provider = c.req.param('provider')
  if (!key || key.provider !== provider) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
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
