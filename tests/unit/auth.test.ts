import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'

vi.mock('../../src/db/client.js', () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
}))

import { pool } from '../../src/db/client.js'

const HASHED_PASSWORD = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' // "secret"

describe('POST /auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns token for valid credentials', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 1, username: 'admin', password_hash: HASHED_PASSWORD, role: 'admin' }],
    } as never)

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('token')
    expect(typeof body.token).toBe('string')
  })

  it('returns 401 for unknown user', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never)

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'unknown', password: 'secret' }),
    })

    expect(res.status).toBe(401)
  })

  it('returns 401 for wrong password', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 1, username: 'admin', password_hash: HASHED_PASSWORD, role: 'admin' }],
    } as never)

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    })

    expect(res.status).toBe(401)
  })
})
