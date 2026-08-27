import { hash } from 'bcryptjs'
import { sign } from 'hono/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import {
  TEST_ENV,
  authHeaders,
  createSqlMock,
  json,
  mockSql,
} from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

// Token where sub matches userId '1' (for self-access tests)
async function selfToken(userId = '1') {
  const token = await sign(
    { sub: userId, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
  return { Authorization: `Bearer ${token}` }
}

const SAMPLE_USER = {
  id: '1',
  name: 'Alice',
  email: 'alice@example.com',
  created_at: '2024-01-01',
}

describe('GET /ui/users', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/ui/users', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/users',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns user list for admin', async () => {
    mockSql([[SAMPLE_USER]])
    const res = await app.request(
      '/ui/users',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(Array.isArray(body.users)).toBe(true)
    expect(body.users[0].email).toBe('alice@example.com')
  })
})

describe('GET /ui/users/:userId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/ui/users/1', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 when user accesses another user profile', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/other-user-id',
      { headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns profile for admin', async () => {
    mockSql([[SAMPLE_USER]])
    const res = await app.request(
      '/ui/users/1',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.user.email).toBe('alice@example.com')
  })

  it('returns own profile for self token', async () => {
    mockSql([[SAMPLE_USER]])
    const res = await app.request(
      '/ui/users/1',
      { headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.user.id).toBe('1')
  })

  it('returns 404 when user not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/1',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})

describe('PATCH /ui/users/:userId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 when user patches another user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/users/other-id',
      {
        method: 'PATCH',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Name' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 200 for admin patching any user', async () => {
    mockSql([[{ id: '99' }]])
    const res = await app.request(
      '/ui/users/99',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
  })

  it('returns 200 for self patch', async () => {
    mockSql([[{ id: '1' }]])
    const res = await app.request(
      '/ui/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Name' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })
})

describe('PATCH /ui/users/:userId — changement de mot de passe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses to change its own password without the current one', async () => {
    mockSql([[{ id: '1' }]])
    const res = await app.request(
      '/ui/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: 'brand-new-password' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('refuses a wrong current password', async () => {
    mockSql([
      [{ id: '1' }], // SELECT user
      [{ password: await hash('the-real-one', 4) }], // SELECT account
    ])
    const res = await app.request(
      '/ui/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: 'brand-new-password',
          currentPassword: 'wrong',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('accepts the change once the current password checks out', async () => {
    mockSql([
      [{ id: '1' }], // SELECT user
      [{ password: await hash('the-real-one', 4) }], // SELECT account
      [], // UPDATE account
    ])
    const res = await app.request(
      '/ui/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: 'brand-new-password',
          currentPassword: 'the-real-one',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('lets an admin reset a password without the current one', async () => {
    mockSql([[{ id: '99' }], []])
    const res = await app.request(
      '/ui/users/99',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: 'reset-by-admin' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('reports a taken email as a conflict instead of a 500', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ id: '1' }]) // SELECT user
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      )
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'taken@example.com' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })
})

describe('POST /ui/users/:userId/repositories', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reuses an existing repository without rewriting its type or config', async () => {
    const sql = mockSql([
      [{ id: 7, type: 'changelog' }], // SELECT repository (déjà présent)
      [{ id: 'link-1', repository_id: 7, created_at: 'now' }], // INSERT user_repository
    ])
    const res = await app.request(
      '/ui/users/1/repositories',
      {
        method: 'POST',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'changelog',
          url: 'https://github.com/facebook/react',
          config: {},
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    // Aucun INSERT INTO repository : la ligne partagée reste intacte.
    // call[0] est la TemplateStringsArray du tag SQL : String() la recolle.
    const statements = sql.mock.calls.map((call) => String(call[0]))
    expect(statements.some((q) => q.includes('INSERT INTO repository'))).toBe(
      false,
    )
  })

  it('refuses to re-declare a known URL under another provider', async () => {
    mockSql([[{ id: 7, type: 'changelog' }]])
    const res = await app.request(
      '/ui/users/1/repositories',
      {
        method: 'POST',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'rss',
          url: 'https://github.com/facebook/react',
          config: {},
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })
})

describe('DELETE /ui/users/:userId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/users/1',
      { method: 'DELETE', headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when user not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/nonexistent',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('deletes user for admin', async () => {
    mockSql([[{ id: '1' }]])
    const res = await app.request(
      '/ui/users/1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
  })
})

// ─── Régression : PATCH ne contenant que `password` ───────────────────────────

describe('PATCH /ui/users/:userId — utilisateur inexistant', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the body only carries a password', async () => {
    mockSql([[]]) // SELECT "user" → aucun résultat
    const res = await app.request(
      '/ui/users/inconnu',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: 'nouveau-mot-de-passe' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('User not found')
  })

  it('returns 404 when the body carries a name', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/inconnu',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Peu importe' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})

// ─── Création d'utilisateur (admin) ───────────────────────────────────────────

describe('POST /ui/users', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/users',
      {
        method: 'POST',
        headers: {
          ...(await selfToken('1')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'A',
          email: 'a@example.com',
          password: 'p',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 when a field is missing', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/ui/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'A', email: 'a@example.com' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
    expect(sql).not.toHaveBeenCalled()
  })

  it('creates the user and returns 201', async () => {
    mockSql([[], []]) // INSERT "user" puis INSERT account
    const res = await app.request(
      '/ui/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Alice',
          email: 'alice@example.com',
          password: 'secret',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.user.email).toBe('alice@example.com')
    expect(body.user.id).toBeDefined()
    expect(body.user).not.toHaveProperty('password')
  })

  it('returns 409 when the email is already taken', async () => {
    const sql = createSqlMock()
    sql.mockImplementationOnce(() => {
      const err = new Error('duplicate') as Error & { code?: string }
      err.code = '23505'
      return Promise.reject(err)
    })
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Alice',
          email: 'alice@example.com',
          password: 'secret',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('Email already in use')
  })
})

// ─── Fil par connecteur ───────────────────────────────────────────────────────

describe('GET /ui/users/:userId/feed/:connector', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 for an unknown connector', async () => {
    const sql = mockSql([[]]) // getTableForProvider: aucune table trouvée
    const res = await app.request(
      '/ui/users/1/feed/inconnu',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('Unknown connector')
    expect(sql).toHaveBeenCalledTimes(1)
  })

  it('returns the connector items for a subscribed user', async () => {
    mockSql([
      [{ table_name: 'connector_rss' }], // getTableForProvider
      [{ repository_id: 3 }], // repositories de l'utilisateur
      [{ column_name: 'repository_id' }], // getRepositoryFkColumn
      [{ id: 10, repository_id: 3, content: 'entrée rss' }], // sql.unsafe
    ])
    const res = await app.request(
      '/ui/users/1/feed/rss',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.connector).toBe('rss')
    expect(body.data).toHaveLength(1)
  })

  it('returns an empty list when the user has no repository of that type', async () => {
    mockSql([
      [{ table_name: 'connector_youtube' }], // getTableForProvider
      [], // repositories de l'utilisateur : aucun
    ])
    const res = await app.request(
      '/ui/users/1/feed/youtube',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).data).toEqual([])
  })
})

// ─── Désabonnement / purge ────────────────────────────────────────────────────

describe('DELETE /ui/users/:userId/repositories/:linkId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the link does not belong to the user', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/1/repositories/link-x',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('only removes the subscription for a scrap feed, never the repository', async () => {
    const sql = mockSql([[{ repository_id: 5, type: 'scrap' }], []])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    // SELECT + DELETE user_repository, et rien d'autre
    expect(sql).toHaveBeenCalledTimes(2)
    expect(sql.unsafe).not.toHaveBeenCalled()
  })

  it('purges the repository for an admin on a non-scrap feed', async () => {
    const sql = mockSql([
      [{ repository_id: 5, type: 'rss' }], // SELECT link
      [{ table_name: 'connector_rss' }], // getTableForProvider
      [], // sql.unsafe : DELETE connector_rss
      [], // DELETE user_repository
      [], // DELETE repository
    ])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(sql.unsafe).toHaveBeenCalledTimes(1)
  })

  it('purges the repository when the last subscriber leaves', async () => {
    const sql = mockSql([
      [{ repository_id: 5, type: 'rss' }], // SELECT link
      [], // DELETE user_repository
      [{ count: '0' }], // plus aucun abonné
      [{ table_name: 'connector_rss' }], // getTableForProvider
      [], // sql.unsafe : DELETE connector_rss
      [], // DELETE user_repository
      [], // DELETE repository
    ])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(sql.unsafe).toHaveBeenCalledTimes(1)
  })

  it('keeps the repository when other subscribers remain', async () => {
    const sql = mockSql([
      [{ repository_id: 5, type: 'rss' }], // SELECT link
      [], // DELETE user_repository
      [{ count: '2' }], // il reste des abonnés
    ])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(sql.unsafe).not.toHaveBeenCalled()
    expect(sql).toHaveBeenCalledTimes(3)
  })
})
