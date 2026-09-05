import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import {
  TEST_ENV,
  authHeaders,
  createSqlMock,
  json,
  mockSql,
} from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

const SAMPLE_REPO = {
  id: 1,
  url: 'https://github.com/test/repo',
  type: 'changelog',
  config: {},
  subscriber_count: '2',
}

describe('GET /ui/repositories', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/ui/repositories', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/repositories',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns repository list for admin', async () => {
    mockSql([[SAMPLE_REPO]])
    const res = await app.request(
      '/ui/repositories',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(Array.isArray(body.repositories)).toBe(true)
    expect(body.repositories[0].url).toBe('https://github.com/test/repo')
    expect(body.repositories[0].subscriber_count).toBe('2')
  })

  it('returns empty list when no repositories', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/repositories',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.repositories).toEqual([])
  })
})

describe('DELETE /ui/repositories/:repoId/data', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/repositories/1/data',
      { method: 'DELETE', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when repository not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/repositories/999/data',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('clears connector data and returns success', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ id: 1, type: 'changelog' }]) // SELECT repository
      .mockResolvedValueOnce([{ table_name: 'connector_changelog' }]) // getTableForProvider
    sql.unsafe = vi.fn().mockResolvedValueOnce([]) // DELETE FROM connector_changelog
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/repositories/1/data',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
  })

  it('succeeds even when connector type has no table (e.g. unknown type)', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ id: 1, type: 'unknown' }]) // SELECT repository
      .mockResolvedValueOnce([]) // getTableForProvider: aucune table trouvée
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/repositories/1/data',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })
})

describe('DELETE /ui/repositories/:repoId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/repositories/1',
      { method: 'DELETE', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when repository not found', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/repositories/999',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('purges repository completely for admin', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ id: 1, type: 'rss' }]) // SELECT repository
      .mockResolvedValueOnce([{ table_name: 'connector_rss' }]) // getTableForProvider
      .mockResolvedValueOnce([]) // DELETE user_repository
      .mockResolvedValueOnce([]) // DELETE repository
    sql.unsafe = vi.fn().mockResolvedValueOnce([]) // DELETE connector data
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/repositories/1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
  })
})

// ─── Création de repository (admin) ───────────────────────────────────────────

describe('POST /ui/repositories', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for user role', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/repositories',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('user')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://example.com', type: 'rss' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 when url or type is missing', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/ui/repositories',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://example.com' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
    expect(sql).not.toHaveBeenCalled()
  })

  it('creates the repository and returns 201', async () => {
    // La route regarde d'abord si l'URL existe déjà, pour ne pas convertir
    // silencieusement le type d'une source partagée.
    mockSql([[], [{ id: 7, url: 'https://example.com/feed', type: 'rss' }]])
    const res = await app.request(
      '/ui/repositories',
      {
        method: 'POST',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://example.com/feed',
          type: 'rss',
          config: { interval: 60 },
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body).toEqual({
      id: 7,
      url: 'https://example.com/feed',
      type: 'rss',
    })
  })
})

// ─── PATCH /ui/repositories/:repoId ────────────────────────────────────────────

describe('PATCH /ui/repositories/:repoId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renames the url and updates the config', async () => {
    // getSource ; updateSourceUrl ; updateSourceConfig
    const sql = mockSql([[SAMPLE_REPO], [], []])
    const res = await app.request(
      '/ui/repositories/1',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://github.com/test/renamed',
          config: { max_scraps: 9 },
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ success: true })
    expect(sql).toHaveBeenCalledTimes(3)
  })

  it('returns 404 for an unknown repository', async () => {
    mockSql([[]])
    const res = await app.request(
      '/ui/repositories/999',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config: {} }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when the new url is already taken', async () => {
    // getSource ; updateSourceUrl (rejette avec code 23505)
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([SAMPLE_REPO])
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/repositories/1',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://taken.example.com' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('returns 404 instead of 500 for a non-numeric id', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/ui/repositories/abc',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config: {} }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(sql).not.toHaveBeenCalled()
  })
})

// ─── Régression : identifiant non numérique ───────────────────────────────────

describe('identifiant de repository non numérique', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 instead of 500 on DELETE /ui/repositories/:repoId', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/ui/repositories/abc',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(sql).not.toHaveBeenCalled()
  })

  it('returns 404 instead of 500 on DELETE /ui/repositories/:repoId/data', async () => {
    const sql = mockSql([])
    const res = await app.request(
      '/ui/repositories/abc/data',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(sql).not.toHaveBeenCalled()
  })
})
