import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, createSqlMock, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

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
    const body = await json(res)
    expect(body).toHaveProperty('token')
    expect(typeof body.token).toBe('string')
    // JWT has 3 parts
    expect(body.token.split('.').length).toBe(3)
  })

  it('returns 409 when email is already in use', async () => {
    const sql = createSqlMock()
    sql.mockImplementationOnce(() => {
      const err = new Error('duplicate') as Error & { code?: string }
      err.code = '23505'
      return Promise.reject(err)
    })
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
    const body = await json(res)
    expect(body).toHaveProperty('error')
  })
})

describe('POST /auth/register — approval mode', () => {
  const APPROVAL_ENV = { ...TEST_ENV, REGISTRATION_MODE: 'approval' }

  beforeEach(() => vi.clearAllMocks())

  function register(body: Record<string, string>) {
    return app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      APPROVAL_ENV,
    )
  }

  it('queues the sign-up and returns 202 without a token', async () => {
    // findUserByEmail → none ; ensurePendingUserTable (unsafe) ; INSERT
    mockSql([[], undefined, undefined])
    const res = await register({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'pass1234',
    })
    expect(res.status).toBe(202)
    const body = await json(res)
    expect(body).toEqual({ status: 'pending_approval' })
    expect(body).not.toHaveProperty('token')
  })

  it('returns 409 when an active account already has that email', async () => {
    mockSql([[{ id: 'u-1', name: 'Alice' }]])
    const res = await register({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'pass1234',
    })
    expect(res.status).toBe(409)
  })

  it('returns 409 when a pending sign-up already has that email', async () => {
    const sql = createSqlMock()
    // findUserByEmail → none
    sql.mockImplementationOnce(() => Promise.resolve([]))
    // ensurePendingUserTable (unsafe) → ok
    sql.unsafe.mockResolvedValueOnce(undefined)
    // INSERT pending_user → unique violation
    sql.mockImplementationOnce(() => {
      const err = new Error('duplicate') as Error & { code?: string }
      err.code = '23505'
      return Promise.reject(err)
    })
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await register({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'pass1234',
    })
    expect(res.status).toBe(409)
  })
})
