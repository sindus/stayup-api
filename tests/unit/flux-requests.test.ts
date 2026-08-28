import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

const SAMPLE = {
  id: 'req-uuid',
  user_id: '1',
  user_email: 'user@example.com',
  provider: 'rss',
  url: 'https://example.com/feed',
  status: 'pending',
  created_at: new Date().toISOString(),
}

describe('GET /ui/flux-requests', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/ui/flux-requests', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/flux-requests',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('lists requests with their provider for an admin', async () => {
    mockSql([[SAMPLE]])
    const res = await app.request(
      '/ui/flux-requests',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.requests[0].provider).toBe('rss')
    expect(body.requests[0].status).toBe('pending')
  })
})

describe('POST /ui/flux-requests/:id/approve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/flux-requests/req-uuid/approve',
      { method: 'POST', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when the request is unknown', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/flux-requests/nope/approve',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('creates the source under the request provider and subscribes the requester', async () => {
    mockSql([
      [
        {
          id: 'req-uuid',
          user_id: '1',
          provider: 'rss',
          url: 'https://x.dev',
          status: 'pending',
        },
      ], // getFluxRequest
      [], // findSourceByUrl → none
      [{ id: 55, url: 'https://x.dev', type: 'rss', config: {} }], // createSource
      [], // subscribe
      [], // setFluxRequestStatus
    ])
    const res = await app.request(
      '/ui/flux-requests/req-uuid/approve',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.repository_id).toBe(55)
  })

  it('409 when the URL already belongs to another provider', async () => {
    mockSql([
      [
        {
          id: 'req-uuid',
          user_id: '1',
          provider: 'rss',
          url: 'https://x.dev',
          status: 'pending',
        },
      ],
      [{ id: 9, url: 'https://x.dev', type: 'changelog', config: {} }], // findSourceByUrl → other provider
    ])
    const res = await app.request(
      '/ui/flux-requests/req-uuid/approve',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })
})

describe('POST /ui/flux-requests/:id/reject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('404 when the request does not exist', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/flux-requests/x/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('409 when the request is no longer pending', async () => {
    mockSql([
      [
        {
          id: 'x',
          user_id: '1',
          provider: 'rss',
          url: 'u',
          status: 'approved',
        },
      ],
    ])
    const res = await app.request(
      '/ui/flux-requests/x/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('rejects a pending request', async () => {
    const sql = mockSql([
      [{ id: 'x', user_id: '1', provider: 'rss', url: 'u', status: 'pending' }],
      [],
    ])
    const res = await app.request(
      '/ui/flux-requests/x/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
    expect(sql).toHaveBeenCalledTimes(2)
  })
})
