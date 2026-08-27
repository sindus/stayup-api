import { sign } from 'hono/jwt'
import { describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

describe('POST /auth/login', () => {
  it('returns token for valid credentials', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: TEST_ENV.API_USERNAME,
          password: TEST_ENV.API_PASSWORD,
        }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toHaveProperty('token')
    expect(typeof body.token).toBe('string')
  })

  it('returns 401 for wrong password', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: TEST_ENV.API_USERNAME,
          password: 'wrong',
        }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(401)
  })

  it('returns 401 for unknown username', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'unknown',
          password: TEST_ENV.API_PASSWORD,
        }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(401)
  })
})

describe('GET /auth/me', () => {
  it('returns 401 without a token', async () => {
    mockSql([])
    const res = await app.request('/auth/me', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 401 for a token signed with another secret', async () => {
    mockSql([])
    const forged = await sign(
      { sub: 'x', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
      'not-the-real-secret',
      'HS256',
    )
    const res = await app.request(
      '/auth/me',
      { headers: { Authorization: `Bearer ${forged}` } },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns the identity carried by a valid token', async () => {
    mockSql([])
    const res = await app.request(
      '/auth/me',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).role).toBe('admin')
  })
})
