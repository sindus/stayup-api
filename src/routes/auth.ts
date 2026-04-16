import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import type { Bindings } from '../types.js'

export const authRoute = new Hono<{ Bindings: Bindings }>()

authRoute.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>()

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
})
