import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

const SAMPLE_REQUEST = {
  id: 'req-uuid',
  user_id: '1',
  user_email: 'user@example.com',
  url: 'https://example.com/blog',
  status: 'pending',
  created_at: new Date().toISOString(),
}

// ─── POST /scrap/requests ─────────────────────────────────────────────────────

describe('POST /scrap/requests', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/scrap/requests',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when url is missing', async () => {
    mockSql([])
    const res = await app.request(
      '/scrap/requests',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 409 when a pending request already exists for this url', async () => {
    mockSql([[{ id: 'existing' }]])
    const res = await app.request(
      '/scrap/requests',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://example.com/blog' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('creates request and returns 201', async () => {
    mockSql([
      [],
      [
        {
          id: 'new-req',
          url: 'https://example.com/blog',
          status: 'pending',
          created_at: new Date().toISOString(),
        },
      ],
    ])
    const res = await app.request(
      '/scrap/requests',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://example.com/blog' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.url).toBe('https://example.com/blog')
    expect(body.status).toBe('pending')
  })
})

// ─── GET /ui/scrap-requests ───────────────────────────────────────────────────

describe('GET /ui/scrap-requests', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/ui/scrap-requests', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/scrap-requests',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns request list for admin', async () => {
    mockSql([[SAMPLE_REQUEST]])
    const res = await app.request(
      '/ui/scrap-requests',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(Array.isArray(body.requests)).toBe(true)
    expect(body.requests[0].url).toBe('https://example.com/blog')
    expect(body.requests[0].status).toBe('pending')
  })
})

// ─── POST /ui/scrap-requests/:id/approve ─────────────────────────────────────

describe('POST /ui/scrap-requests/:id/approve', () => {
  beforeEach(() => vi.clearAllMocks())

  const approveBody = {
    url: 'https://example.com/blog',
    config: {
      articles_selector: 'h2 a',
      content_selector: 'article',
      max_scraps: 5,
      retention_days: 15,
    },
  }

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/scrap-requests/req-uuid/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(approveBody),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/scrap-requests/req-uuid/approve',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(approveBody),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when request not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/scrap-requests/unknown/approve',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(approveBody),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when request already approved', async () => {
    mockSql([[{ id: 'req-uuid', user_id: '1', status: 'approved' }]])
    const res = await app.request(
      '/ui/scrap-requests/req-uuid/approve',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(approveBody),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('approves request: creates repo, subscribes user, returns 200', async () => {
    mockSql([
      [{ id: 'req-uuid', user_id: '1', status: 'pending' }], // fetch request
      [], // SELECT repository (aucun dépôt existant pour cette URL)
      [{ id: 42 }], // INSERT repository
      [], // INSERT user_repository
      [], // UPDATE scrap_request status
    ])
    const res = await app.request(
      '/ui/scrap-requests/req-uuid/approve',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(approveBody),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.repository_id).toBe(42)
  })
})

// ─── Rejet d'une demande ──────────────────────────────────────────────────────

describe('POST /ui/scrap-requests/:id/reject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/scrap-requests/req-1/reject',
      { method: 'POST' },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/scrap-requests/req-1/reject',
      { method: 'POST', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when the request does not exist', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/scrap-requests/req-1/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('Request not found')
  })

  it('returns 409 when the request is no longer pending', async () => {
    mockSql([[{ id: 'req-1', status: 'approved' }]])
    const res = await app.request(
      '/ui/scrap-requests/req-1/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('Request is not pending')
  })

  it('rejects a pending request', async () => {
    const sql = mockSql([[{ id: 'req-1', status: 'pending' }], []])
    const res = await app.request(
      '/ui/scrap-requests/req-1/reject',
      { method: 'POST', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
    expect(sql).toHaveBeenCalledTimes(2) // SELECT puis UPDATE
  })
})
