import { describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV } from '../helpers.js'

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
    const body = await res.json()
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
