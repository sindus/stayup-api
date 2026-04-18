import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV } from '../helpers.js'

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

describe('POST /auth/register', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when name is missing', async () => {
    mockSql([])
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'pass123',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when password is missing', async () => {
    mockSql([])
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('creates user and returns 201 with JWT token', async () => {
    // INSERT user → no return value; INSERT account → no return value
    mockSql([undefined, undefined])
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice',
          email: 'alice@example.com',
          password: 'pass123',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toHaveProperty('token')
    expect(typeof body.token).toBe('string')
    // JWT has 3 parts
    expect(body.token.split('.').length).toBe(3)
  })

  it('returns 409 when email is already in use', async () => {
    const sql = vi.fn().mockImplementationOnce(() => {
      const err = new Error('duplicate') as Error & { code?: string }
      err.code = '23505'
      return Promise.reject(err)
    })
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice',
          email: 'existing@example.com',
          password: 'pass123',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })
})
