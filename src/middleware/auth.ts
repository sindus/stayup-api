import { jwt } from 'hono/jwt'
import type { Context, Next } from 'hono'

export const authMiddleware = (c: Context, next: Next) =>
  jwt({ secret: process.env.JWT_SECRET ?? 'changeme' })(c, next)

export const requireAdmin = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload') as { role?: string }
  if (payload?.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}
