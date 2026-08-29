import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { closeSql, getSql, trackOpenConnections } from '../../src/db/client.js'

// closeSql() ne ferme que les connexions suivies : le suivi est opt-in.
trackOpenConnections(true)
import type { Bindings } from '../../src/types.js'
import { authHeaders, json } from '../helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FUNCTIONAL_ENV: Bindings = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup_test'}`,
  JWT_SECRET: 'test-secret',
  UI_URL: 'http://localhost:3001',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  GITHUB_CLIENT_ID: '',
  GITHUB_CLIENT_SECRET: '',
  REGISTRATION_MODE: 'open',
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

  // connector_changelog / connector_youtube appartiennent normalement aux projets
  // collecteurs indépendants (stayup-cmd-changelog, stayup-cmd-youtube) — recréées ici
  // uniquement pour les besoins des tests fonctionnels de stayup-api, en suivant le
  // même contrat qu'un vrai collecteur (table connector_<name> + ligne provider_registry).
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS connector_changelog (
      id            SERIAL PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repository(id),
      version       TEXT,
      content       TEXT NOT NULL,
      diff          TEXT,
      datetime      TIMESTAMPTZ,
      executed_at   TIMESTAMPTZ NOT NULL,
      success       BOOLEAN NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_youtube (
      id            SERIAL PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repository(id),
      version       TEXT,
      content       TEXT NOT NULL,
      diff          TEXT,
      datetime      TIMESTAMPTZ,
      executed_at   TIMESTAMPTZ NOT NULL,
      success       BOOLEAN NOT NULL
    );
    INSERT INTO provider_registry (name, display_name, sort_order)
    VALUES ('changelog', 'Changelog', 10), ('youtube', 'YouTube', 20)
    ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name;
  `)

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

  // L'auth admin passe désormais par la table `admin` : on sème un super admin.
  const { hash } = await import('bcryptjs')
  await sql.unsafe(
    `INSERT INTO admin (id, email, name, password_hash, is_super)
     VALUES ('functional-admin', 'admin@functest.local', 'Root', '${await hash('testpass', 10)}', true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_super = true`,
  )
})

afterAll(async () => {
  await sql.unsafe(`
    DELETE FROM user_repository WHERE user_id = '${testUserId}';
    DELETE FROM "user" WHERE id = '${testUserId}';
    DELETE FROM connector_changelog WHERE repository_id = ${repoId};
    DELETE FROM repository WHERE id = ${repoId};
    DELETE FROM admin WHERE id = 'functional-admin';
  `)
  await closeSql()
})

// ─── Health ───────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns health check without auth', async () => {
    const res = await app.request('/', {}, FUNCTIONAL_ENV)
    expect(res.status).toBe(200)
    const body = await json(res)
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
        body: JSON.stringify({
          username: 'admin@functest.local',
          password: 'testpass',
        }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toHaveProperty('token')
  })

  it('returns 401 for invalid credentials', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin@functest.local',
          password: 'wrong',
        }),
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
        body: JSON.stringify({
          username: 'admin@functest.local',
          password: 'testpass',
        }),
      },
      FUNCTIONAL_ENV,
    )
    const { token } = await json(loginRes)
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
    const body = await json(res)
    expect(body.connectors).toHaveProperty('changelog')
    expect(body.connectors).toHaveProperty('youtube')
  })
})

describe('GET /connectors/providers', () => {
  it('returns the discovered providers with their display name', async () => {
    const res = await app.request(
      '/connectors/providers',
      { headers: await authHeaders('user') },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    const changelog = body.providers.find(
      (p: { name: string }) => p.name === 'changelog',
    )
    expect(changelog).toEqual({
      name: 'changelog',
      displayName: 'Changelog',
      fluxApproval: 'auto',
    })
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
    const body = await json(res)
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
    const body = await json(res)
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
    const body = await json(res)
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
        }),
      },
      FUNCTIONAL_ENV,
    )
    expect(res.status).toBe(201)
    const body = await json(res)
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
    const body = await json(res)
    expect(body.repositories.length).toBe(1)
    expect(body.repositories[0].provider).toBe('changelog')
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
    const body = await json(res)
    expect(body.success).toBe(true)
  })
})
