import { Hono } from 'hono'
import {
  connectorKeyPrefix,
  generateConnectorKey,
  hashConnectorKey,
} from '../db/connectorKeys.js'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

// Gestion admin des clés d'API de connectors — distinct de `/connector-api`,
// que les clés elles-mêmes appellent. Auth JWT admin classique ici.
export const adminConnectorKeysRoute = new Hono<{ Bindings: Bindings }>()

adminConnectorKeysRoute.use('*', authMiddleware)
adminConnectorKeysRoute.use('*', requireAdmin)

// POST / — { provider, name }. `provider` est du texte libre, pas restreint
// aux providers déjà enregistrés : c'est la toute première clé d'un provider
// qui n'a jamais tourné qui lui permettra de s'enregistrer. La clé en clair
// n'est renvoyée qu'ici, une seule fois — ensuite seul son hash est gardé.
adminConnectorKeysRoute.post('/', async (c) => {
  const body = await c.req.json<{ provider?: string; name?: string }>()

  if (!body.provider || !body.name) {
    return c.json({ error: 'provider and name are required' }, 400)
  }

  const key = generateConnectorKey()
  const store = await getStore(c.env.DATABASE_URL)
  const created = await store.createConnectorKey({
    provider: body.provider,
    name: body.name,
    keyHash: await hashConnectorKey(key),
    keyPrefix: connectorKeyPrefix(key),
  })

  return c.json(
    { id: created.id, provider: body.provider, name: body.name, key },
    201,
  )
})

// GET / — liste des clés, sans jamais le secret (seul `key_prefix` identifie
// une clé dans l'interface).
adminConnectorKeysRoute.get('/', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const keys = await store.listConnectorKeys()
  return c.json({ keys })
})

// DELETE /:id — révocation. 404 si la clé n'existe pas ou est déjà révoquée.
adminConnectorKeysRoute.delete('/:id', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const revoked = await store.revokeConnectorKey(c.req.param('id'))
  if (!revoked) return c.json({ error: 'Key not found' }, 404)
  return c.json({ success: true })
})
