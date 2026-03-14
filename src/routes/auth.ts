import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import bcrypt from 'bcryptjs'
import { pool } from '../db/client.js'

type User = {
  id: number
  username: string
  password_hash: string
  role: string
}

export const authRoute = new Hono()

authRoute.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>()

  const result = await pool.query<User>('SELECT * FROM users WHERE username = $1', [body.username])
  const user = result.rows[0]

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
    process.env.JWT_SECRET ?? 'changeme',
  )

  return c.json({ token })
})
