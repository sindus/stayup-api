import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
}))

import { getPool } from '../../src/db/client.js'

const HASHED_PASSWORD = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' // "secret"

describe('POST /auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns token for valid credentials', async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: 1, username: 'admin', password_hash: HASHED_PASSWORD, role: 'admin' }],
      }),
    } as never)

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
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    } as never)

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
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: 1, username: 'admin', password_hash: HASHED_PASSWORD, role: 'admin' }],
      }),
    } as never)

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
