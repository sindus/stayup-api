import { sign } from 'hono/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, createSqlMock, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

// Token utilisateur dont `sub` est exploité par les handlers scrap
async function userHeaders(sub = 'user-1') {
  const token = await sign(
    { sub, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
  return { Authorization: `Bearer ${token}` }
}

describe('GET /scrap', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/scrap', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns scrap feeds with subscription status', async () => {
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
      '/scrap',
      { headers: await userHeaders() },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.repos).toHaveLength(2)
    expect(body.repos[0].is_subscribed).toBe(true)
    expect(body.repos[1].is_subscribed).toBe(false)
  })

  it('returns an empty list when no scrap feed exists', async () => {
    mockSql([[]])
    const res = await app.request(
      '/scrap',
      { headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).repos).toEqual([])
  })
})

describe('POST /scrap/:repoId/subscribe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/scrap/1/subscribe',
      { method: 'POST' },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when repoId is not a number', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/scrap/abc/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    // Le garde-fou doit court-circuiter avant toute requête SQL
    expect(sql).not.toHaveBeenCalled()
  })

  it('returns 404 when the scrap feed does not exist', async () => {
    mockSql([[]])
    const res = await app.request(
      '/scrap/99/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('Scrap feed not found')
  })

  it('subscribes the user and returns 201', async () => {
    // L'INSERT rend la ligne créée : le mock doit la fournir.
    mockSql([[{ id: 1, type: 'scrap' }], [{ id: 'link-1', repository_id: 1 }]])
    const res = await app.request(
      '/scrap/1/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    expect((await json(res)).success).toBe(true)
  })

  it('returns 409 when already subscribed', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ id: 1, type: 'scrap' }]) // SELECT repository
      .mockImplementationOnce(() => {
        const err = new Error('duplicate') as Error & { code?: string }
        err.code = '23505'
        return Promise.reject(err)
      })
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/scrap/1/subscribe',
      { method: 'POST', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('Already subscribed')
  })
})

describe('DELETE /scrap/:repoId/subscribe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request(
      '/scrap/1/subscribe',
      { method: 'DELETE' },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when repoId is not a number', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/scrap/abc/subscribe',
      { method: 'DELETE', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(sql).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not subscribed', async () => {
    mockSql([[]])
    const res = await app.request(
      '/scrap/1/subscribe',
      { method: 'DELETE', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('Not subscribed')
  })

  it('unsubscribes and returns success', async () => {
    mockSql([[{ id: 'link-1' }]])
    const res = await app.request(
      '/scrap/1/subscribe',
      { method: 'DELETE', headers: await userHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
  })
})
