import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { getSql } from '../db/client.js'
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
  const passwordHash = await hash(body.password, 10)
  const userId = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    await sql`
      INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
      VALUES (${userId}, ${body.name}, ${body.email}, ${now}, ${now}, false)
    `
    await sql`
      INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
      VALUES (
        ${accountId},
        ${userId},
        'credential',
        ${body.email},
        ${passwordHash},
        ${now},
        ${now}
      )
    `
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Email already in use' }, 409)
    }
    throw err
  }

  const token = await sign(
    userTokenPayload(userId, body.name, body.email),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token }, 201)
})
