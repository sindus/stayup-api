import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import app from '../../src/app.js'
import { TEST_ENV } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({
  getSql: vi.fn(),
}))

import { getSql } from '../../src/db/client.js'

let HASHED_PASSWORD: string
beforeAll(async () => {
  HASHED_PASSWORD = await bcrypt.hash('secret', 10)
})

describe('POST /auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns token for valid credentials', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, username: 'admin', password_hash: HASHED_PASSWORD, role: 'admin' }])
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'secret' }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('token')
    expect(typeof body.token).toBe('string')
  })

  it('returns 401 for unknown user', async () => {
    const sql = vi.fn().mockResolvedValueOnce([])
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'unknown', password: 'secret' }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(401)
  })

  it('returns 401 for wrong password', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, username: 'admin', password_hash: HASHED_PASSWORD, role: 'admin' }])
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      },
      TEST_ENV,
    )

    expect(res.status).toBe(401)
  })
})
