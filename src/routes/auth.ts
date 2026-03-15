import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import bcrypt from 'bcryptjs'
import type { Bindings } from '../types.js'
import { getSql } from '../db/client.js'

type User = {
  id: number
  username: string
  password_hash: string
  role: string
}

export const authRoute = new Hono<{ Bindings: Bindings }>()

authRoute.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>()
  const sql = getSql(c.env.DATABASE_URL)

  const [user] = await sql<User[]>`SELECT * FROM users WHERE username = ${body.username}`

  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await sign(
    {
      sub: String(user.id),
      username: user.username,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token })
})
