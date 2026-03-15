import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import type { Bindings } from '../types.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import { getSql } from '../db/client.js'

type User = {
  id: number
  username: string
  role: string
  created_at: string
}

export const usersRoute = new Hono<{ Bindings: Bindings }>()

usersRoute.use('*', authMiddleware)
usersRoute.use('*', requireAdmin)

// GET /users — list all users
usersRoute.get('/', async (c) => {
  const sql = getSql(c.env.DATABASE_URL)
  const users = await sql<User[]>`SELECT id, username, role, created_at FROM users ORDER BY id`
  return c.json({ users })
})

// POST /users — create a user
usersRoute.post('/', async (c) => {
  const body = await c.req.json<{ username: string; password: string; role?: string }>()

  if (!body.username || !body.password) {
    return c.json({ error: 'username and password are required' }, 400)
  }

  const role = body.role ?? 'user'
  if (!['user', 'admin'].includes(role)) {
    return c.json({ error: 'role must be "user" or "admin"' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)
  const passwordHash = await bcrypt.hash(body.password, 10)

  try {
    const [user] = await sql<User[]>`
      INSERT INTO users (username, password_hash, role)
      VALUES (${body.username}, ${passwordHash}, ${role})
      RETURNING id, username, role, created_at
    `
    return c.json({ user }, 201)
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: `User "${body.username}" already exists` }, 409)
    }
    throw err
  }
})

// PATCH /users/:id — update username, password or role
usersRoute.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ username?: string; password?: string; role?: string }>()

  if (!body.username && !body.password && !body.role) {
    return c.json({ error: 'at least one field is required (username, password, role)' }, 400)
  }

  if (body.role && !['user', 'admin'].includes(body.role)) {
    return c.json({ error: 'role must be "user" or "admin"' }, 400)
  }

  const sql = getSql(c.env.DATABASE_URL)

  const [existing] = await sql<User[]>`SELECT id FROM users WHERE id = ${id}`
  if (!existing) {
    return c.json({ error: 'User not found' }, 404)
  }

  if (body.username) {
    await sql`UPDATE users SET username = ${body.username} WHERE id = ${id}`
  }
  if (body.password) {
    const hash = await bcrypt.hash(body.password, 10)
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`
  }
  if (body.role) {
    await sql`UPDATE users SET role = ${body.role} WHERE id = ${id}`
  }

  const [user] = await sql<User[]>`SELECT id, username, role, created_at FROM users WHERE id = ${id}`
  return c.json({ user })
})

// DELETE /users/:id — delete a user
usersRoute.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getSql(c.env.DATABASE_URL)

  const [deleted] = await sql<User[]>`
    DELETE FROM users WHERE id = ${id} RETURNING id, username, role, created_at
  `
  if (!deleted) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json({ user: deleted })
})
