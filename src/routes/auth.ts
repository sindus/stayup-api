import { compare } from 'bcryptjs'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { getSql } from '../db/client.js'
import { createCredentialUser } from '../db/users.js'
import type { Bindings } from '../types.js'

export const authRoute = new Hono<{ Bindings: Bindings }>()

function userTokenPayload(userId: string, name: string, email: string) {
  return {
    sub: userId,
    role: 'user',
    name,
    email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  }
}

// POST /auth/login
authRoute.post('/login', async (c) => {
  const body = await c.req.json<{
    username?: string
    email?: string
    password: string
  }>()

  // Admin login via env var credentials
  if (body.username) {
    if (
      body.username !== c.env.API_USERNAME ||
      body.password !== c.env.API_PASSWORD
    ) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const token = await sign(
      {
        sub: 'api',
        username: body.username,
        role: 'admin',
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
      },
      c.env.JWT_SECRET,
      'HS256',
    )

    return c.json({ token })
  }

  // User login via email + password
  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const rows = await sql<{ id: string; name: string; password: string }[]>`
    SELECT u.id, u.name, a.password
    FROM "user" u
    JOIN account a ON a.user_id = u.id
    WHERE u.email = ${body.email}
      AND a.provider_id = 'credential'
    LIMIT 1
  `

  if (rows.length === 0) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const { id: userId, name, password: passwordHash } = rows[0]

  const valid = await compare(body.password, passwordHash)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await sign(
    userTokenPayload(userId, name, body.email),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token })
})

// POST /auth/register (public)
authRoute.post('/register', async (c) => {
  const body = await c.req.json<{
    name: string
    email: string
    password: string
  }>()

  if (!body.name || !body.email || !body.password) {
    return c.json({ error: 'name, email and password are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)
  const created = await createCredentialUser(sql, body)

  if (!created) {
    return c.json({ error: 'Email already in use' }, 409)
  }

  const token = await sign(
    userTokenPayload(created.id, body.name, body.email),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token }, 201)
})
