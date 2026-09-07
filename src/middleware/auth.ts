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

/**
 * Accès à `/ui/repositories/*` pour un admin (JWT) OU une clé connector — sans
 * quoi un connector qui gère lui-même ses flux (ex. `scrap`/admin.py) aurait
 * besoin d'un vrai compte admin (email + mot de passe) rien que pour ça, un
 * credential bien plus large et non révocable sans changer le mot de passe.
 * Une clé connector reste scopée à son provider : voir `providerScope`, à
 * appliquer dans chaque route pour restreindre l'accès aux repositories de ce
 * seul provider.
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

/** `null` = admin JWT, accès complet. Une chaîne = clé connector, accès
 *  restreint aux repositories de ce provider. À appeler après
 *  `requireAdminOrOwnProviderKey`. */
export const providerScope = (c: Context): string | null => {
  const key = c.get('connectorKey') as { provider: string } | undefined
  return key?.provider ?? null
}

/**
 * Accès à `POST /ui/maintenance/cleanup` : un admin (JWT) OU le porteur du
 * secret `CLEANUP_SECRET`. Le cron de nettoyage n'est pas une session : il ne
 * peut pas tenir un JWT de 24 h, d'où ce secret long, posé côté serveur, envoyé
 * en `Authorization: Bearer`. Comparaison en temps constant. Si `CLEANUP_SECRET`
 * n'est pas configuré, seul le chemin admin reste ouvert.
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

/** Comparaison à durée constante de deux chaînes courtes. */
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
