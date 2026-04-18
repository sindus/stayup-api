import { compare } from 'bcryptjs'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { getSql } from '../db/client.js'
import type { Bindings } from '../types.js'

export const authRoute = new Hono<{ Bindings: Bindings }>()

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

  // User login via email + password (Better Auth account table)
  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const rows = await sql<{ id: string; password: string }[]>`
    SELECT u.id, a.password
    FROM "user" u
    JOIN account a ON a.user_id = u.id
    WHERE u.email = ${body.email}
      AND a.provider_id = 'credential'
    LIMIT 1
  `

  if (rows.length === 0) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const { id: userId, password: hash } = rows[0]

  const valid = await compare(body.password, hash)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await sign(
    {
      sub: userId,
      role: 'user',
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token })
})
