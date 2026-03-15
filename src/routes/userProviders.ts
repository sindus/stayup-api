import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

type UserProvider = {
  id: number
  provider_type: string
  provider_id: number
  created_at: string
}

export const userProvidersRoute = new Hono<{ Bindings: Bindings }>()

userProvidersRoute.use('*', authMiddleware)

function canAccess(
  jwt: { username: string; role: string },
  username: string,
): boolean {
  return jwt.role === 'admin' || jwt.username === username
}

// GET /user/:username/providers — list user's subscribed providers
userProvidersRoute.get('/:username/providers', async (c) => {
  const username = c.req.param('username')
  const jwt = c.get('jwtPayload') as { username: string; role: string }

  if (!canAccess(jwt, username)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const [user] = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE username = ${username}
  `
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const providers = await sql<UserProvider[]>`
    SELECT id, provider_type, provider_id, created_at
    FROM user_providers
    WHERE user_id = ${user.id}
    ORDER BY id
  `
  return c.json({ providers })
})

// POST /user/:username/providers — subscribe to a provider
userProvidersRoute.post('/:username/providers', async (c) => {
  const username = c.req.param('username')
  const jwt = c.get('jwtPayload') as { username: string; role: string }

  if (!canAccess(jwt, username)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json<{
    provider_type: string
    provider_id: number
  }>()

  if (!body.provider_type || !body.provider_id) {
    return c.json({ error: 'provider_type and provider_id are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const [user] = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE username = ${username}
  `
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Verify the provider actually exists
  const [providerExists] = (await sql.unsafe(
    `SELECT id FROM "${body.provider_type}" WHERE id = $1`,
    [body.provider_id],
  )) as { id: number }[]
  if (!providerExists) {
    return c.json(
      { error: `Provider ${body.provider_type}#${body.provider_id} not found` },
      404,
    )
  }

  try {
    const [provider] = await sql<UserProvider[]>`
      INSERT INTO user_providers (user_id, provider_type, provider_id)
      VALUES (${user.id}, ${body.provider_type}, ${body.provider_id})
      RETURNING id, provider_type, provider_id, created_at
    `
    return c.json({ provider }, 201)
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Provider already subscribed' }, 409)
    }
    throw err
  }
})

// DELETE /user/:username/providers/:id — unsubscribe from a provider
userProvidersRoute.delete('/:username/providers/:id', async (c) => {
  const username = c.req.param('username')
  const providerId = Number(c.req.param('id'))
  const jwt = c.get('jwtPayload') as { username: string; role: string }

  if (!canAccess(jwt, username)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const [user] = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE username = ${username}
  `
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const [deleted] = await sql<UserProvider[]>`
    DELETE FROM user_providers
    WHERE id = ${providerId} AND user_id = ${user.id}
    RETURNING id, provider_type, provider_id, created_at
  `
  if (!deleted) {
    return c.json({ error: 'Provider subscription not found' }, 404)
  }

  return c.json({ provider: deleted })
})
