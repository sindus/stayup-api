import { sign } from 'hono/jwt'
import type { Bindings } from '../src/types.js'

export const TEST_ENV: Bindings = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret',
}

export async function bearerToken(
  role: 'user' | 'admin' = 'user',
  username = role === 'admin' ? 'testadmin' : 'testuser',
): Promise<string> {
  return sign(
    {
      sub: '1',
      username,
      role,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
}

export async function authHeaders(
  role: 'user' | 'admin' = 'user',
  username?: string,
): Promise<HeadersInit> {
  return { Authorization: `Bearer ${await bearerToken(role, username)}` }
}
