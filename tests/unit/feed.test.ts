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

describe('GET /feed/:username (auth)', () => {
  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/feed/testuser', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 when accessing another user feed', async () => {
    mockSql([])
    const res = await app.request(
      '/feed/otheruser',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /feed/:username', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when user not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns empty feed when user has no providers', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [], // user_providers empty
    ])
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.feed).toEqual({})
  })

  it('returns feed with latest content per matching connector', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [{ provider_type: 'repository', provider_id: 10 }], // user_providers
      [
        {
          connector_table: 'connector_changelog',
          provider_table: 'repository',
          fk_column: 'provider_id',
        },
      ], // FK info
      [], // datetime column check (no datetime col)
      [{ id: 5, provider_id: 10, content: 'latest changelog' }], // unsafe: data
    ])
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.feed).toHaveProperty('changelog')
    expect(body.feed.changelog).toEqual([
      { id: 5, provider_id: 10, content: 'latest changelog' },
    ])
  })

  it('skips connectors whose provider type the user is not subscribed to', async () => {
    mockSql([
      [{ id: 1 }], // user lookup
      [{ provider_type: 'repository', provider_id: 10 }], // user_providers (no profile)
      [
        {
          connector_table: 'connector_changelog',
          provider_table: 'repository',
          fk_column: 'provider_id',
        },
        {
          connector_table: 'connector_youtube',
          provider_table: 'profile',
          fk_column: 'provider_id',
        },
      ], // FK info
      [], // datetime column check for changelog (no datetime col)
      [{ id: 5, provider_id: 10, content: 'latest changelog' }], // unsafe: changelog data
      // youtube is skipped — no profile subscriptions
    ])
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.feed).toHaveProperty('changelog')
    expect(body.feed).not.toHaveProperty('youtube')
  })

  it('admin can access any user feed', async () => {
    mockSql([
      [{ id: 2 }], // user lookup
      [], // user_providers empty
    ])
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })
})
