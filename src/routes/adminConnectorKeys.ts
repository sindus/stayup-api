import { Hono } from 'hono'
import {
  connectorKeyPrefix,
  generateConnectorKey,
  hashConnectorKey,
} from '../db/connectorKeys.js'
import { getStore } from '../db/store.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

// Admin management of connector API keys — distinct from `/connector-api`,
// which the keys themselves call. Plain admin JWT auth here.
export const adminConnectorKeysRoute = new Hono<{ Bindings: Bindings }>()

adminConnectorKeysRoute.use('*', authMiddleware)
adminConnectorKeysRoute.use('*', requireAdmin)

// POST / — { provider, name }. `provider` is free text, not restricted to
// already-registered providers: it is the very first key of a provider that has
// never run that lets it register itself. The plaintext key is returned only
// here, once — afterwards only its hash is kept.
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

// GET / — list of keys, never the secret (only `key_prefix` identifies a key
// in the UI).
adminConnectorKeysRoute.get('/', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const keys = await store.listConnectorKeys()
  return c.json({ keys })
})

// DELETE /:id — revocation. 404 if the key does not exist or is already revoked.
adminConnectorKeysRoute.delete('/:id', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const revoked = await store.revokeConnectorKey(c.req.param('id'))
  if (!revoked) return c.json({ error: 'Key not found' }, 404)
  return c.json({ success: true })
})
