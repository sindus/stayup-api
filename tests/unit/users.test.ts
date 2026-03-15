import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({
  getSql: vi.fn(),
}))

import { getSql } from '../../src/db/client.js'

function mockSql(responses: unknown[]) {
  let call = 0
  const sql = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses[call++] ?? []))
  sql.unsafe = vi.fn()
  vi.mocked(getSql).mockReturnValue(sql as never)
  return sql
}

describe('GET /users (auth)', () => {
  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/users', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin user', async () => {
    mockSql([])
    const res = await app.request(
      '/users',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /users', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns list of users', async () => {
    mockSql([
      [
        {
          id: 1,
          username: 'sikander',
          role: 'admin',
          created_at: '2026-01-01',
        },
        { id: 2, username: 'app', role: 'admin', created_at: '2026-01-02' },
      ],
    ])

    const res = await app.request(
      '/users',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.users).toHaveLength(2)
  })
})

describe('POST /users', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a user and returns 201', async () => {
    mockSql([
      [{ id: 3, username: 'newuser', role: 'user', created_at: '2026-01-03' }],
    ])

    const res = await app.request(
      '/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'newuser',
          password: 'pass123',
          role: 'user',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.user.username).toBe('newuser')
  })

  it('returns 400 when username is missing', async () => {
    mockSql([])
    const res = await app.request(
      '/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: 'pass123' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 409 when username already exists', async () => {
    const sql = vi.fn().mockRejectedValueOnce({ code: '23505' })
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: 'existing', password: 'pass123' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('returns 400 for invalid role', async () => {
    mockSql([])
    const res = await app.request(
      '/users',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'newuser',
          password: 'pass123',
          role: 'superadmin',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })
})

describe('PATCH /users/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('updates user role and returns updated user', async () => {
    mockSql([
      [{ id: 1 }], // existing check
      [], // update role
      [{ id: 1, username: 'sikander', role: 'user', created_at: '2026-01-01' }], // select updated
    ])

    const res = await app.request(
      '/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.role).toBe('user')
  })

  it('returns 404 for unknown user', async () => {
    mockSql([[]])

    const res = await app.request(
      '/users/999',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for empty body', async () => {
    mockSql([])
    const res = await app.request(
      '/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid role', async () => {
    mockSql([])
    const res = await app.request(
      '/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'superadmin' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 409 when username already taken', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }]) // existing check
      .mockRejectedValueOnce({ code: '23505' }) // duplicate username update
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/users/1',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: 'existing' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })
})

describe('DELETE /users/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes a user and returns it', async () => {
    mockSql([
      [{ id: 2, username: 'app', role: 'admin', created_at: '2026-01-02' }],
    ])

    const res = await app.request(
      '/users/2',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.username).toBe('app')
  })

  it('returns 404 for unknown user', async () => {
    mockSql([[]])

    const res = await app.request(
      '/users/999',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
