import { sign } from 'hono/jwt'

export async function bearerToken(role: 'user' | 'admin' = 'user'): Promise<string> {
  return sign(
    { sub: '1', username: 'testuser', role, exp: Math.floor(Date.now() / 1000) + 3600 },
    process.env.JWT_SECRET ?? 'changeme',
    'HS256',
  )
}

export async function authHeaders(role: 'user' | 'admin' = 'user'): Promise<HeadersInit> {
  return { Authorization: `Bearer ${await bearerToken(role)}` }
}
