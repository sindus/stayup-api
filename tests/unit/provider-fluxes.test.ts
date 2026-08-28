import { sign } from 'hono/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, createSqlMock, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

async function userHeaders(sub = 'user-1') {
  const token = await sign(
    { sub, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
  return { Authorization: `Bearer ${token}` }
}

describe('GET /providers/:provider/fluxes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/providers/scrap/fluxes', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('lists the fluxes of that provider with subscription status', async () => {
    mockSql([
      [
        {
          id: 1,
          url: 'https://example.com/a',
          config: {},
          created_at: '2024-01-01',
          is_subscribed: true,
        },
        {
          id: 2,
          url: 'https://example.com/b',
          config: {},
          created_at: '2024-01-02',
          is_subscribed: false,
        },
      ],
    ])

    const res = await app.request(
      '/providers/rss/fluxes',
      { headers: await userHeaders() },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.fluxes).toHaveLength(2)
    expect(body.fluxes[0].is_subscribed).toBe(true)
    expect(body.fluxes[1].is_subscribed).toBe(false)
  })

  it('returns an empty list when the provider has no flux', async () => {
    mockSql([[]])
    const res = await app.request(
      '/providers/rss/fluxes',
      { headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).fluxes).toEqual([])
  })
})

describe('POST /providers/:provider/fluxes/:id/subscribe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'POST' },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when id is not a number', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/providers/rss/fluxes/abc/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(sql).not.toHaveBeenCalled()
  })

  it('returns 404 when the flux does not exist for this provider', async () => {
    mockSql([[]])
    const res = await app.request(
      '/providers/rss/fluxes/99/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('Flux not found')
  })

  it('returns 404 when the flux belongs to another provider', async () => {
    mockSql([[{ id: 1, type: 'scrap' }]])
    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('subscribes the user and returns 201', async () => {
    mockSql([[{ id: 1, type: 'rss' }], [{ id: 'link-1', repository_id: 1 }]])
    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    expect((await json(res)).success).toBe(true)
  })

  it('returns 409 when already subscribed', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ id: 1, type: 'rss' }])
      .mockImplementationOnce(() => {
        const err = new Error('duplicate') as Error & { code?: string }
        err.code = '23505'
        return Promise.reject(err)
      })
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('Already subscribed')
  })
})

describe('DELETE /providers/:provider/fluxes/:id/subscribe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'DELETE' },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user is not subscribed', async () => {
    mockSql([[]])
    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'DELETE', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('Not subscribed')
  })

  it('unsubscribes and returns success', async () => {
    mockSql([[{ id: 'link-1' }]])
    const res = await app.request(
      '/providers/rss/fluxes/1/subscribe',
      { method: 'DELETE', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
  })
})
