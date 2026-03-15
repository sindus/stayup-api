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

let repoId: number
let profileId: number

beforeAll(async () => {
  const schema = readFileSync(
    join(__dirname, '../../src/db/schema.sql'),
    'utf-8',
  )
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

  const [repo] = (await sql.unsafe(
    `INSERT INTO repository (url) VALUES ('https://github.com/test/repo')
     ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
     RETURNING id`,
  )) as { id: number }[]
  repoId = repo.id

  const [profile] = (await sql.unsafe(
    `INSERT INTO profile (url) VALUES ('https://youtube.com/@testchannel')
     ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
     RETURNING id`,
  )) as { id: number }[]
  profileId = profile.id
})

afterAll(async () => {
  await sql.unsafe(`
    DROP TABLE IF EXISTS user_providers CASCADE;
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

describe('/users', () => {
  let managedUserId: number

  describe('GET /users', () => {
    it('returns 401 without token', async () => {
      const res = await app.request('/users', {}, FUNCTIONAL_ENV)
      expect(res.status).toBe(401)
    })

    it('returns 403 for non-admin', async () => {
      const res = await app.request(
        '/users',
        { headers: await authHeaders('user') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(403)
    })

    it('returns list of users for admin', async () => {
      const res = await app.request(
        '/users',
        { headers: await authHeaders('admin') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.users)).toBe(true)
      expect(body.users.length).toBeGreaterThan(0)
    })
  })

  describe('POST /users', () => {
    it('creates a user and returns 201', async () => {
      const res = await app.request(
        '/users',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: 'functest_managed',
            password: 'pass123',
            role: 'user',
          }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.user.username).toBe('functest_managed')
      expect(body.user.role).toBe('user')
      managedUserId = body.user.id
    })

    it('returns 400 when password is missing', async () => {
      const res = await app.request(
        '/users',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ username: 'functest_invalid' }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(400)
    })

    it('returns 409 when username already exists', async () => {
      const res = await app.request(
        '/users',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: 'functest_managed',
            password: 'other',
          }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(409)
    })
  })

  describe('PATCH /users/:id', () => {
    it('updates user role', async () => {
      const res = await app.request(
        `/users/${managedUserId}`,
        {
          method: 'PATCH',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ role: 'admin' }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.user.role).toBe('admin')
    })

    it('returns 400 for empty body', async () => {
      const res = await app.request(
        `/users/${managedUserId}`,
        {
          method: 'PATCH',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(400)
    })

    it('returns 409 when username already taken', async () => {
      const res = await app.request(
        `/users/${managedUserId}`,
        {
          method: 'PATCH',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ username: 'testuser' }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(409)
    })

    it('returns 404 for unknown user', async () => {
      const res = await app.request(
        '/users/999999',
        {
          method: 'PATCH',
          headers: {
            ...(await authHeaders('admin')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ role: 'user' }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /users/:id', () => {
    it('deletes a user and returns it', async () => {
      const res = await app.request(
        `/users/${managedUserId}`,
        { method: 'DELETE', headers: await authHeaders('admin') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.user.id).toBe(managedUserId)
    })

    it('returns 404 for unknown user', async () => {
      const res = await app.request(
        '/users/999999',
        { method: 'DELETE', headers: await authHeaders('admin') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(404)
    })
  })
})

describe('/user/:username/providers', () => {
  let providerSubscriptionId: number

  describe('GET /user/:username/providers', () => {
    it('returns 401 without token', async () => {
      const res = await app.request(
        '/user/testuser/providers',
        {},
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(401)
    })

    it('returns 403 when accessing another user providers', async () => {
      const res = await app.request(
        '/user/testadmin/providers',
        { headers: await authHeaders('user') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(403)
    })

    it('returns empty providers list initially', async () => {
      const res = await app.request(
        '/user/testuser/providers',
        { headers: await authHeaders('user') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.providers)).toBe(true)
    })
  })

  describe('POST /user/:username/providers', () => {
    it('returns 400 when provider_id is missing', async () => {
      const res = await app.request(
        '/user/testuser/providers',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('user')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ provider_type: 'repository' }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(400)
    })

    it('returns 404 when provider does not exist', async () => {
      const res = await app.request(
        '/user/testuser/providers',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('user')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider_type: 'repository',
            provider_id: 999999,
          }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(404)
    })

    it('subscribes to a repository and returns 201', async () => {
      const res = await app.request(
        '/user/testuser/providers',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('user')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider_type: 'repository',
            provider_id: repoId,
          }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.provider.provider_type).toBe('repository')
      expect(body.provider.provider_id).toBe(repoId)
      providerSubscriptionId = body.provider.id
    })

    it('returns 409 when already subscribed', async () => {
      const res = await app.request(
        '/user/testuser/providers',
        {
          method: 'POST',
          headers: {
            ...(await authHeaders('user')),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider_type: 'repository',
            provider_id: repoId,
          }),
        },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(409)
    })
  })

  describe('DELETE /user/:username/providers/:id', () => {
    it('returns 404 for unknown subscription', async () => {
      const res = await app.request(
        '/user/testuser/providers/999999',
        { method: 'DELETE', headers: await authHeaders('user') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(404)
    })

    it('removes a subscription and returns it', async () => {
      const res = await app.request(
        `/user/testuser/providers/${providerSubscriptionId}`,
        { method: 'DELETE', headers: await authHeaders('user') },
        FUNCTIONAL_ENV,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.provider.id).toBe(providerSubscriptionId)
    })
  })
})

describe('GET /feed/:username', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/feed/testuser', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 when accessing another user feed', async () => {
    const res = await app.request(
      '/feed/testadmin',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 for unknown user', async () => {
    const res = await app.request(
      '/feed/unknownuser',
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns feed object for authenticated user', async () => {
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('feed')
    expect(typeof body.feed).toBe('object')
  })

  it('admin can access any user feed', async () => {
    const res = await app.request(
      '/feed/testuser',
      { headers: await authHeaders('admin') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
  })
})
