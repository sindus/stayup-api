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

const TEST_EMAIL = 'func-users-repos@example.com'
const TEST_EMAIL_2 = 'func-users-repos-2@example.com'
const REPO_URL = 'https://github.com/func-test/users-repos-test'

let registeredUserId: string
let registeredUserToken: string
let createdRepoId: number

beforeAll(async () => {
  const schema = readFileSync(
    join(__dirname, '../../src/db/schema.sql'),
    'utf-8',
  )
  await sql.unsafe(schema)
  // Ensure clean state
  await sql.unsafe(
    `DELETE FROM "user" WHERE email IN ('${TEST_EMAIL}', '${TEST_EMAIL_2}')`,
  )
  await sql.unsafe(`DELETE FROM repository WHERE url = '${REPO_URL}'`)
})

afterAll(async () => {
  await sql.unsafe(
    `DELETE FROM user_repository WHERE repository_id = ${createdRepoId ?? 0}`,
  )
  await sql.unsafe(`DELETE FROM repository WHERE url = '${REPO_URL}'`)
  await sql.unsafe(
    `DELETE FROM "user" WHERE email IN ('${TEST_EMAIL}', '${TEST_EMAIL_2}')`,
  )
  await sql.end()
})

// ─── Register ─────────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 400 when fields are missing', async () => {
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('creates user and returns 201 with token', async () => {
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Func User',
          email: TEST_EMAIL,
          password: 'pass123',
        }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toHaveProperty('token')
    registeredUserToken = body.token
    const payload = JSON.parse(
      Buffer.from(body.token.split('.')[1], 'base64url').toString(),
    ) as { sub: string }
    registeredUserId = payload.sub
  })

  it('returns 409 on duplicate email', async () => {
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Dupe',
          email: TEST_EMAIL,
          password: 'pass123',
        }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(409)
  })
})

// ─── User list (admin) ────────────────────────────────────────────────────────

describe('GET /ui/users', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/ui/users', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    const res = await app.request(
      '/ui/users',
      { headers: { Authorization: `Bearer ${registeredUserToken}` } },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns user list for admin', async () => {
    const res = await app.request(
      '/ui/users',
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.users)).toBe(true)
    const found = body.users.find(
      (u: { email: string }) => u.email === TEST_EMAIL,
    )
    expect(found).toBeDefined()
  })
})

// ─── User profile ─────────────────────────────────────────────────────────────

describe('GET /ui/users/:userId', () => {
  it('returns profile for admin', async () => {
    const res = await app.request(
      `/ui/users/${registeredUserId}`,
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.email).toBe(TEST_EMAIL)
  })

  it('returns own profile for self token', async () => {
    const res = await app.request(
      `/ui/users/${registeredUserId}`,
      { headers: { Authorization: `Bearer ${registeredUserToken}` } },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe(registeredUserId)
  })

  it('returns 403 for other user token', async () => {
    const res = await app.request(
      '/ui/users/some-other-user-id',
      { headers: { Authorization: `Bearer ${registeredUserToken}` } },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 for unknown userId', async () => {
    const res = await app.request(
      '/ui/users/00000000-0000-0000-0000-000000000000',
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })
})

// ─── Update user ──────────────────────────────────────────────────────────────

describe('PATCH /ui/users/:userId', () => {
  it('updates name for admin', async () => {
    const res = await app.request(
      `/ui/users/${registeredUserId}`,
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Func User' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('updates name for self', async () => {
    const res = await app.request(
      `/ui/users/${registeredUserId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${registeredUserToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Self Updated' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('returns 403 when user patches another account', async () => {
    const res = await app.request(
      '/ui/users/some-other-id',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${registeredUserToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hack' }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })
})

// ─── Admin repositories ───────────────────────────────────────────────────────

describe('GET /ui/repositories', () => {
  beforeAll(async () => {
    const [repo] = (await sql.unsafe(
      `INSERT INTO repository (url, type, config) VALUES ('${REPO_URL}', 'rss', '{}') RETURNING id`,
    )) as { id: number }[]
    createdRepoId = repo.id
  })

  it('returns 401 without token', async () => {
    const res = await app.request('/ui/repositories', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    const res = await app.request(
      '/ui/repositories',
      { headers: { Authorization: `Bearer ${registeredUserToken}` } },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns repository list with subscriber_count for admin', async () => {
    const res = await app.request(
      '/ui/repositories',
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.repositories)).toBe(true)
    const found = body.repositories.find(
      (r: { url: string }) => r.url === REPO_URL,
    )
    expect(found).toBeDefined()
    expect(found.subscriber_count).toBeDefined()
  })
})

describe('DELETE /ui/repositories/:repoId/data', () => {
  it('returns 403 for user role', async () => {
    const res = await app.request(
      `/ui/repositories/${createdRepoId}/data`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${registeredUserToken}` },
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 for unknown repository', async () => {
    const res = await app.request(
      '/ui/repositories/99999999/data',
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('clears connector data for admin', async () => {
    const res = await app.request(
      `/ui/repositories/${createdRepoId}/data`,
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })
})

describe('DELETE /ui/repositories/:repoId', () => {
  it('returns 404 for unknown repository', async () => {
    const res = await app.request(
      '/ui/repositories/99999999',
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('purges repository completely for admin', async () => {
    const res = await app.request(
      `/ui/repositories/${createdRepoId}`,
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // Verify it's gone
    const check =
      (await sql`SELECT id FROM repository WHERE id = ${createdRepoId}`) as unknown[]
    expect(check.length).toBe(0)
  })
})

// ─── Delete user (admin) ──────────────────────────────────────────────────────

describe('DELETE /ui/users/:userId', () => {
  it('returns 403 for user role', async () => {
    const res = await app.request(
      `/ui/users/${registeredUserId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${registeredUserToken}` },
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 for unknown userId', async () => {
    const res = await app.request(
      '/ui/users/00000000-0000-0000-0000-000000000000',
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('deletes user for admin', async () => {
    // Create a second user to delete (don't delete our registeredUser mid-suite)
    const regRes = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'To Delete',
          email: TEST_EMAIL_2,
          password: 'pass123',
        }),
      },
      FUNCTIONAL_ENV,
    )
    const { token } = await regRes.json()
    const { sub: deleteId } = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as { sub: string }

    const res = await app.request(
      `/ui/users/${deleteId}`,
      { method: 'DELETE', headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })
})
