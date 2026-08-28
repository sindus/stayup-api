import { hash } from 'bcryptjs'
import { sign } from 'hono/jwt'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

describe('POST /auth/login (admin)', () => {
  let adminHash: string
  const adminRow = () => ({
    id: 'adm-1',
    email: 'root@stayup.test',
    name: 'Root',
    password_hash: adminHash,
    is_super: true,
  })

  beforeAll(async () => {
    adminHash = await hash('s3cret', 10)
  })

  it('returns a token for a matching admin account', async () => {
    mockSql([[adminRow()]])
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'root@stayup.test',
          password: 's3cret',
        }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(typeof body.token).toBe('string')
    const claims = JSON.parse(
      Buffer.from(body.token.split('.')[1], 'base64url').toString(),
    )
    expect(claims.role).toBe('admin')
    expect(claims.is_super).toBe(true)
  })

  it('returns 401 for a wrong password', async () => {
    mockSql([[adminRow()]])
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'root@stayup.test',
          password: 'wrong',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for an unknown admin e-mail', async () => {
    mockSql([[]])
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'nobody@stayup.test',
          password: 's3cret',
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
