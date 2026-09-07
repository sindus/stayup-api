import { sign } from 'hono/jwt'
import { type Mock, vi } from 'vitest'
import { getSql } from '../src/db/client.js'
import type { Bindings } from '../src/types.js'

export const TEST_ENV: Bindings = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret',
  UI_URL: 'http://localhost:3001',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GITHUB_CLIENT_ID: 'github-client-id',
  GITHUB_CLIENT_SECRET: 'github-client-secret',
  REGISTRATION_MODE: 'open',
  INSTANCE_NAME: '',
  CLEANUP_SECRET: 'test-cleanup-secret',
}

export async function bearerToken(
  role: 'user' | 'admin' = 'user',
  username = role === 'admin' ? 'testadmin' : 'testuser',
  isSuper = false,
): Promise<string> {
  return sign(
    {
      sub: '1',
      username,
      role,
      ...(role === 'admin' ? { is_super: isSuper } : {}),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
}

export async function authHeaders(
  role: 'user' | 'admin' = 'user',
  username?: string,
  isSuper?: boolean,
): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await bearerToken(role, username, isSuper)}`,
  }
}

// Corps de réponse de test : la forme varie d'un endpoint à l'autre.
// biome-ignore lint/suspicious/noExplicitAny: assertions de test sur du JSON dynamique
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// Tag SQL factice : appelable comme template littéral, plus .unsafe(), .begin()
// et .json() — l'adaptateur passe les configs par ce dernier.
export type SqlMock = Mock & { unsafe: Mock; begin: Mock; json: Mock }

export function createSqlMock(): SqlMock {
  const sql = Object.assign(vi.fn(), {
    unsafe: vi.fn(),
    // `sql.begin(fn)` exécute fn avec le même tag factice : les requêtes de la
    // transaction sont donc comptées comme les autres dans l'ordre des appels.
    begin: vi.fn(),
    // postgres.js emballe la valeur pour la typer en jsonb ; ici, elle passe telle quelle.
    json: vi.fn((value: unknown) => value),
  }) as SqlMock
  sql.begin.mockImplementation((fn: (tx: SqlMock) => unknown) => fn(sql))
  return sql
}

// Remplace getSql par un tag SQL factice qui répond dans l'ordre des appels.
// Nécessite vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() })) dans le test.
export function mockSql(responses: unknown[]): SqlMock {
  let call = 0
  const next = () => Promise.resolve(responses[call++] ?? [])

  const sql = createSqlMock()
  sql.mockImplementation(next)
  sql.unsafe.mockImplementation(next)
  sql.begin.mockImplementation((fn: (tx: SqlMock) => unknown) => fn(sql))

  vi.mocked(getSql).mockReturnValue(sql as never)
  return sql
}
