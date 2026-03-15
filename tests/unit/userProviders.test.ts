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
  sql.unsafe = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses[call++] ?? []))
  vi.mocked(getSql).mockReturnValue(sql as never)
  return sql
}

describe('GET /user/:username/providers (auth)', () => {
  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/user/testuser/providers', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 when accessing another user providers', async () => {
    mockSql([])
    const res = await app.request(
      '/user/otheruser/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /user/:username/providers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when user not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/user/testuser/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns list of subscribed providers', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [
        {
          id: 1,
          provider_type: 'repository',
          provider_id: 10,
          created_at: '2026-01-01',
        },
      ], // providers
    ])
    const res = await app.request(
      '/user/testuser/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.providers).toHaveLength(1)
    expect(body.providers[0].provider_type).toBe('repository')
  })

  it('admin can access any user providers', async () => {
    mockSql([
      [{ id: 2 }], // user lookup
      [], // providers
    ])
    const res = await app.request(
      '/user/testuser/providers',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /user/:username/providers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when fields are missing', async () => {
    mockSql([])
    const res = await app.request(
      '/user/testuser/providers',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider_type: 'repository' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when user not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/user/testuser/providers',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider_type: 'repository', provider_id: 10 }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when provider does not exist', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [], // unsafe: provider not found
    ])
    const res = await app.request(
      '/user/testuser/providers',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider_type: 'repository', provider_id: 999 }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('creates a subscription and returns 201', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [{ id: 10 }], // unsafe: provider exists
      [
        {
          id: 1,
          provider_type: 'repository',
          provider_id: 10,
          created_at: '2026-01-01',
        },
      ], // INSERT RETURNING
    ])
    const res = await app.request(
      '/user/testuser/providers',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider_type: 'repository', provider_id: 10 }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.provider.provider_type).toBe('repository')
    expect(body.provider.provider_id).toBe(10)
  })

  it('returns 409 when already subscribed', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }]) // user lookup
      .mockRejectedValueOnce({ code: '23505' }) // INSERT throws
    sql.unsafe = vi.fn().mockResolvedValueOnce([{ id: 10 }]) // provider exists
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/user/testuser/providers',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider_type: 'repository', provider_id: 10 }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })
})

describe('DELETE /user/:username/providers/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 when accessing another user providers', async () => {
    mockSql([])
    const res = await app.request(
      '/user/otheruser/providers/1',
      { method: 'DELETE', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when subscription not found', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [], // DELETE returns nothing
    ])
    const res = await app.request(
      '/user/testuser/providers/999',
      { method: 'DELETE', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('removes a subscription and returns it', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [
        {
          id: 5,
          provider_type: 'repository',
          provider_id: 10,
          created_at: '2026-01-01',
        },
      ], // DELETE RETURNING
    ])
    const res = await app.request(
      '/user/testuser/providers/5',
      { method: 'DELETE', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provider.id).toBe(5)
    expect(body.provider.provider_type).toBe('repository')
  })
})
