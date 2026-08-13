import { sign } from 'hono/jwt'
import { type Mock, vi } from 'vitest'
import { getSql } from '../src/db/client.js'
import type { Bindings } from '../src/types.js'

export const TEST_ENV: Bindings = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret',
  API_USERNAME: 'testadmin',
  API_PASSWORD: 'testpass',
  UI_URL: 'http://localhost:3001',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GITHUB_CLIENT_ID: 'github-client-id',
  GITHUB_CLIENT_SECRET: 'github-client-secret',
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
): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await bearerToken(role, username)}` }
}

// Corps de réponse de test : la forme varie d'un endpoint à l'autre.
// biome-ignore lint/suspicious/noExplicitAny: assertions de test sur du JSON dynamique
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// Tag SQL factice : appelable comme template littéral, plus une méthode .unsafe().
export type SqlMock = Mock & { unsafe: Mock }

export function createSqlMock(): SqlMock {
  return Object.assign(vi.fn(), { unsafe: vi.fn() }) as SqlMock
}

// Remplace getSql par un tag SQL factice qui répond dans l'ordre des appels.
// Nécessite vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() })) dans le test.
export function mockSql(responses: unknown[]): SqlMock {
  let call = 0
  const next = () => Promise.resolve(responses[call++] ?? [])

  const sql = createSqlMock()
  sql.mockImplementation(next)
  sql.unsafe.mockImplementation(next)

  vi.mocked(getSql).mockReturnValue(sql as never)
  return sql
}
