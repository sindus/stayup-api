import { sign } from 'hono/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

function mockSql(responses: unknown[]) {
  let call = 0
  const sql = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses[call++] ?? []))
  sql.unsafe = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses[call++] ?? []))
  vi.mocked(getSql).mockReturnValue(sql as never)
  return sql
}

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
    const body = await res.json()
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
    const body = await res.json()
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
    const body = await res.json()
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
    const body = await res.json()
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
    const body = await res.json()
    expect(body.success).toBe(true)
  })
})
