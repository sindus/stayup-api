import type { Context, Next } from 'hono'
import { jwt } from 'hono/jwt'
import type { Bindings } from '../types.js'

export const authMiddleware = (c: Context, next: Next) => {
  const env = c.env as Bindings
  return jwt({ secret: env.JWT_SECRET, alg: 'HS256' })(c, next)
}

export const requireAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { role?: string }
  if (payload?.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}

export const requireSelfOrAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { sub?: string; role?: string }
  if (payload?.role === 'admin') {
    await next()
    return
  }
  const userId = c.req.param('userId')
  if (payload?.role === 'user' && payload?.sub === userId) {
    await next()
    return
  }
  return c.json({ error: 'Forbidden' }, 403)
}
