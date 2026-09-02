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

  it('creates the flux immediately for an `auto` provider', async () => {
    mockSql([
      [], // findSourceByUrl → none
      [{ name: 'rss', flux_approval: 'auto' }], // readRegistry
      [{ id: 12, url: 'https://blog.dev/feed', type: 'rss', config: {} }], // createSource
      [{ id: 'link-9', repository_id: 12, created_at: 'now' }], // subscribe
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
          provider: 'rss',
          url: 'https://blog.dev/feed',
          config: {},
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    expect((await json(res)).repository.provider).toBe('rss')
  })

  it('queues a request (202) for a `manual` provider when a user adds an unknown flux', async () => {
    mockSql([
      [], // findSourceByUrl → none
      [{ name: 'scrap', flux_approval: 'manual' }], // readRegistry
      [], // findPendingFluxRequest → none
      [
        {
          id: 'req-1',
          user_id: '1',
          provider: 'scrap',
          url: 'https://new.dev',
          status: 'pending',
          created_at: 'now',
        },
      ], // createFluxRequest
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
          provider: 'scrap',
          url: 'https://new.dev',
          config: {},
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(202)
    const body = await json(res)
    expect(body.status).toBe('pending')
    expect(body.request.provider).toBe('scrap')
  })

  it('lets an admin bypass approval on a `manual` provider', async () => {
    mockSql([
      [], // findSourceByUrl → none
      [{ id: 20, url: 'https://x.dev', type: 'scrap', config: {} }], // createSource (no readRegistry: admin skips the check)
      [{ id: 'link-a', repository_id: 20, created_at: 'now' }], // subscribe
    ])
    const res = await app.request(
      '/ui/users/1/repositories',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'scrap',
          url: 'https://x.dev',
          config: {},
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
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

describe('Pending sign-ups (approval mode)', () => {
  beforeEach(() => vi.clearAllMocks())

  const PENDING_ROW = {
    id: 'p-1',
    name: 'Ada',
    email: 'ada@example.com',
    password_hash: 'hash',
    oauth_provider: null,
    oauth_account_id: null,
    created_at: '2026-01-01',
  }

  it('GET /ui/users/pending requires an admin', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/users/pending',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('GET /ui/users/pending lists the queue with a method label', async () => {
    mockSql([
      [
        PENDING_ROW,
        {
          ...PENDING_ROW,
          id: 'p-2',
          password_hash: null,
          oauth_provider: 'github',
        },
      ],
    ])
    const res = await app.request(
      '/ui/users/pending',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.users).toHaveLength(2)
    expect(body.users[0]).toMatchObject({ id: 'p-1', method: 'password' })
    expect(body.users[1].method).toBe('github')
    expect(body.users[0]).not.toHaveProperty('password_hash')
  })

  it('POST /ui/users/pending/:id/approve creates the account and clears the row', async () => {
    // getPendingUser → row ; createCredentialUser INSERT user + INSERT account ;
    // deletePendingUser DELETE RETURNING
    mockSql([[PENDING_ROW], undefined, undefined, [{ id: 'new-user' }]])
    const res = await app.request(
      '/ui/users/pending/p-1/approve',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.user).toMatchObject({ name: 'Ada', email: 'ada@example.com' })
  })

  it('POST /ui/users/pending/:id/approve returns 404 for an unknown id', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/pending/nope/approve',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('POST /ui/users/pending/:id/reject drops the row', async () => {
    mockSql([[{ id: 'p-1' }]])
    const res = await app.request(
      '/ui/users/pending/p-1/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
  })

  it('POST /ui/users/pending/:id/reject returns 404 when nothing was removed', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/users/pending/nope/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
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

  // Retirer un flux de sa liste ne fait QUE désabonner : jamais de suppression
  // de la source `repository` ni de son contenu `connector_*` (régression :
  // purger sur "dernier abonné parti" effaçait des données du collecteur).
  it('a regular user leaving an auto provider only unsubscribes', async () => {
    const sql = mockSql([
      [{ repository_id: 5, type: 'rss' }], // findSubscription
      [], // DELETE user_repository
    ])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    // findSubscription + DELETE user_repository, rien d'autre : ni readRegistry,
    // ni countSubscribers, ni DELETE connector_*, ni DELETE repository.
    expect(sql).toHaveBeenCalledTimes(2)
    expect(sql.unsafe).not.toHaveBeenCalled()
  })

  it('an admin removing a flux from their own list also only unsubscribes', async () => {
    const sql = mockSql([
      [{ repository_id: 5, type: 'rss' }], // findSubscription
      [], // DELETE user_repository
    ])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(sql).toHaveBeenCalledTimes(2)
    expect(sql.unsafe).not.toHaveBeenCalled()
  })

  it('a curated (manual) provider is no different — unsubscribe only', async () => {
    const sql = mockSql([
      [{ repository_id: 5, type: 'scrap' }], // findSubscription
      [], // DELETE user_repository
    ])
    const res = await app.request(
      '/ui/users/1/repositories/link-1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(sql).toHaveBeenCalledTimes(2)
    expect(sql.unsafe).not.toHaveBeenCalled()
  })
})

describe('parseExternalLinkId', () => {
  it('round-trips a data-source-scoped link id', async () => {
    const { parseExternalLinkId } = await import('../../src/routes/uiUsers.js')
    expect(parseExternalLinkId('ext:7:https%3A%2F%2Fx.dev%2Ffeed')).toEqual({
      dataSourceId: 7,
      url: 'https://x.dev/feed',
    })
    expect(parseExternalLinkId('link-1')).toBeNull()
    expect(parseExternalLinkId('ext:notnum:x')).toBeNull()
  })
})

describe('DELETE /ui/users/:userId/repositories/:linkId — external flux', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unsubscribes from a secondary-database flux without purging anything', async () => {
    // ensureMultiDbTables (unsafe) ; DELETE external_subscription RETURNING → one row
    const sql = mockSql([undefined, [{ id: 'es-1' }]])
    const res = await app.request(
      '/ui/users/1/repositories/ext:5:https%3A%2F%2Fblog.dev%2Ffeed',
      { method: 'DELETE', headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
    // No connector_* / repository purge on a read-only secondary base.
    expect(sql.unsafe).toHaveBeenCalledTimes(1)
  })

  it('404s when the external subscription was not there', async () => {
    mockSql([undefined, []])
    const res = await app.request(
      '/ui/users/1/repositories/ext:5:https%3A%2F%2Fnope.dev',
      { method: 'DELETE', headers: await selfToken('1') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
