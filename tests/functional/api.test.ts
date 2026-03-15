import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getSql } from '../../src/db/client.js'
import type { Bindings } from '../../src/types.js'
import { authHeaders } from '../helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FUNCTIONAL_ENV: Bindings = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup_test'}`,
  JWT_SECRET: 'test-secret',
}

const sql = getSql(FUNCTIONAL_ENV.DATABASE_URL)

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../src/db/schema.sql'), 'utf-8')
  await sql.unsafe(schema)

  const bcrypt = await import('bcryptjs')
  const userHash = await bcrypt.hash('userpass', 10)
  const adminHash = await bcrypt.hash('adminpass', 10)
  await sql.unsafe(
    `INSERT INTO users (username, password_hash, role) VALUES
      ('testuser', '${userHash}', 'user'),
      ('testadmin', '${adminHash}', 'admin')
     ON CONFLICT (username) DO NOTHING`,
  )
})

afterAll(async () => {
  await sql.unsafe(`
    DROP TABLE IF EXISTS log CASCADE;
    DROP TABLE IF EXISTS connector_youtube CASCADE;
    DROP TABLE IF EXISTS connector_changelog CASCADE;
    DROP TABLE IF EXISTS profile CASCADE;
    DROP TABLE IF EXISTS repository CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `)
  await sql.end()
})

describe('GET /', () => {
  it('returns health check without auth', async () => {
    const res = await app.request('/', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok' })
  })
})

describe('POST /auth/login', () => {
  it('returns token for valid credentials', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'userpass' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('token')
  })

  it('returns 401 for invalid credentials', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'wrong' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(401)
  })
})

describe('GET /connectors (auth)', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/connectors', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    const res = await app.request(
      '/connectors',
      { headers: { Authorization: 'Bearer invalid.token.here' } },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(401)
  })
})

describe('GET /connectors', () => {
  it('returns connector tables for user', async () => {
    const res = await app.request(
      '/connectors',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connectors).toHaveProperty('changelog')
    expect(body.connectors).toHaveProperty('youtube')
  })
})

describe('GET /connectors/latest (auth)', () => {
  it('returns 403 for user role', async () => {
    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 200 for admin role', async () => {
    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('latest')
  })
})

describe('GET /connectors/:name', () => {
  it('returns latest per provider_id for changelog', async () => {
    const res = await app.request(
      '/connectors/changelog',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connector).toBe('changelog')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns 404 for unknown connector', async () => {
    const res = await app.request(
      '/connectors/unknown',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })
})

describe('token returned by /auth/login works', () => {
  it('uses real login token to access protected route', async () => {
    const loginRes = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'userpass' }),
      },
      FUNCTIONAL_ENV,
    )
    const { token } = await loginRes.json()

    const res = await app.request(
      '/connectors',
      { headers: { Authorization: `Bearer ${token}` } },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
  })
})
