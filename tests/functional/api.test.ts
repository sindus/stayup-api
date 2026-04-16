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
  API_USERNAME: 'testadmin',
  API_PASSWORD: 'testpass',
}

const sql = getSql(FUNCTIONAL_ENV.DATABASE_URL)

let repoId: number
let userLinkId: string
const testUserId = 'functional-test-user-id'

beforeAll(async () => {
  const schema = readFileSync(
    join(__dirname, '../../src/db/schema.sql'),
    'utf-8',
  )
  await sql.unsafe(schema)

  // Seed a "user" row so user_repository FK is satisfied
  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('${testUserId}', 'Test User', 'functest@example.com', false, now(), now())
     ON CONFLICT (id) DO NOTHING`,
  )

  const [repo] = (await sql.unsafe(
    `INSERT INTO repository (url, type, config) VALUES ('https://github.com/test/repo', 'changelog', '{}')
     ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
     RETURNING id`,
  )) as { id: number }[]
  repoId = repo.id
})

afterAll(async () => {
  await sql.unsafe(`
    DELETE FROM user_repository WHERE user_id = '${testUserId}';
    DELETE FROM "user" WHERE id = '${testUserId}';
    DELETE FROM connector_changelog WHERE repository_id = ${repoId};
    DELETE FROM repository WHERE id = ${repoId};
  `)
  await sql.end()
})

// ─── Health ───────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns health check without auth', async () => {
    const res = await app.request('/', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok' })
  })
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns token for valid credentials', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testadmin', password: 'testpass' }),
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
        body: JSON.stringify({ username: 'testadmin', password: 'wrong' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('token from login works on protected route', async () => {
    const loginRes = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testadmin', password: 'testpass' }),
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

// ─── Connectors ───────────────────────────────────────────────────────────────

describe('GET /connectors (auth guard)', () => {
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
  it('returns connector tables', async () => {
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

describe('GET /connectors/latest', () => {
  it('returns 403 for non-admin', async () => {
    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 200 for admin', async () => {
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
  it('returns data for changelog', async () => {
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

// ─── UI users ─────────────────────────────────────────────────────────────────

describe('GET /ui/users/:userId/feed', () => {
  it('returns 401 without token', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/feed`,
      {},
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/feed`,
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns empty feed when user has no repositories', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/feed`,
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.repositories).toEqual([])
    expect(body.connectors.changelog).toEqual([])
    expect(body.connectors.youtube).toEqual([])
  })
})

describe('POST /ui/users/:userId/repositories', () => {
  it('returns 401 without token', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/repositories`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when required fields are missing', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/repositories`,
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'changelog' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('creates a user_repository link and returns 201', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/repositories`,
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'changelog',
          url: 'https://github.com/test/repo',
          config: {},
          label: 'Test Repo',
        }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.repository.label).toBe('Test Repo')
    expect(body.repository.provider).toBe('changelog')
    userLinkId = body.repository.id
  })

  it('returns 409 when already subscribed', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/repositories`,
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'changelog',
          url: 'https://github.com/test/repo',
          config: {},
          label: 'Test Repo',
        }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(409)
  })
})

describe('GET /ui/users/:userId/feed (with data)', () => {
  it('returns repositories and connectors after subscription', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/feed`,
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.repositories.length).toBe(1)
    expect(body.repositories[0].label).toBe('Test Repo')
  })
})

describe('DELETE /ui/users/:userId/repositories/:linkId', () => {
  it('returns 404 for unknown link', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/repositories/nonexistent-id`,
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('deletes the link and returns success', async () => {
    const res = await app.request(
      `/ui/users/${testUserId}/repositories/${userLinkId}`,
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })
})
