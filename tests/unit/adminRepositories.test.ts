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
      .mockResolvedValueOnce([]) // getTableForProvider: no table found
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

// ─── Repository creation (admin) ─────────────────────────────────────────────

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
    // The route first checks whether the URL already exists, so as not to
    // silently convert a shared source's type.
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
    // getSource; updateSourceUrl (rejects with code 23505)
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

// ─── Regression: non-numeric id ──────────────────────────────────────────────

describe('non-numeric repository id', () => {
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

// ─── Auth by connector key, scoped to its own provider ────────────────────────
// A connector that manages its own fluxes (e.g. stayup-cmd-scrap/admin.py) no
// longer needs a dedicated admin account: its existing /connector-api key is
// but only for repositories of its own type.

const connectorKeyHeaders = { Authorization: 'Bearer stayup_conn_testkey' }

// The key goes through `ensureConnectorKeyTable` (sql.unsafe) then the SELECT
// of `findConnectorKeyByHash`, then `touchConnectorKeyUsage` (best-effort) —
// three sql calls consumed before the route is even reached.
function keyAuthResponses(provider: string) {
  return [[], [{ id: 'key1', provider }], []]
}

describe('Auth by connector key on /ui/repositories', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for an unknown connector key', async () => {
    mockSql([[], []]) // ensureConnectorKeyTable ; findConnectorKeyByHash -> rien
    const res = await app.request(
      '/ui/repositories',
      { headers: connectorKeyHeaders },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('lists only repositories of the key own provider', async () => {
    mockSql([
      ...keyAuthResponses('scrap'),
      [
        { ...SAMPLE_REPO, id: 1, type: 'scrap' },
        { ...SAMPLE_REPO, id: 2, type: 'rss' },
      ],
    ])
    const res = await app.request(
      '/ui/repositories',
      { headers: connectorKeyHeaders },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.repositories).toEqual([
      expect.objectContaining({ id: 1, type: 'scrap' }),
    ])
  })

  it('creates a repository of its own provider', async () => {
    mockSql([
      ...keyAuthResponses('scrap'),
      [], // findSourceByUrl
      [{ id: 9, url: 'https://example.com/scrap', type: 'scrap' }], // createSource
    ])
    const res = await app.request(
      '/ui/repositories',
      {
        method: 'POST',
        headers: { ...connectorKeyHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/scrap',
          type: 'scrap',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
  })

  it('refuses to create a repository of another provider', async () => {
    const sql = mockSql([...keyAuthResponses('scrap')])
    const res = await app.request(
      '/ui/repositories',
      {
        method: 'POST',
        headers: { ...connectorKeyHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/feed', type: 'rss' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
    // 2 tagged sql calls from auth (the 3rd, ensureConnectorKeyTable, goes
    // through .unsafe and is not counted here), no more: refused before any
    // source read.
    expect(sql).toHaveBeenCalledTimes(2)
  })

  it('updates a repository of its own provider', async () => {
    mockSql([
      ...keyAuthResponses('scrap'),
      [{ ...SAMPLE_REPO, id: 1, type: 'scrap' }], // getSource
      [], // updateSourceConfig
    ])
    const res = await app.request(
      '/ui/repositories/1',
      {
        method: 'PATCH',
        headers: { ...connectorKeyHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { max_scraps: 5 } }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('hides a repository belonging to another provider (404, not 403)', async () => {
    mockSql([
      ...keyAuthResponses('scrap'),
      [{ ...SAMPLE_REPO, id: 1, type: 'rss' }], // getSource
    ])
    const res = await app.request(
      '/ui/repositories/1',
      {
        method: 'PATCH',
        headers: { ...connectorKeyHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {} }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('deletes a repository of its own provider', async () => {
    mockSql([
      ...keyAuthResponses('scrap'),
      [{ ...SAMPLE_REPO, id: 1, type: 'scrap' }], // getSource
      [], // deleteContentForSource
      [], // deleteSubscriptionsForSource
      [], // deleteSource
    ])
    const res = await app.request(
      '/ui/repositories/1',
      { method: 'DELETE', headers: connectorKeyHeaders },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('refuses to delete a repository of another provider', async () => {
    const sql = mockSql([
      ...keyAuthResponses('scrap'),
      [{ ...SAMPLE_REPO, id: 1, type: 'rss' }], // getSource
    ])
    const res = await app.request(
      '/ui/repositories/1',
      { method: 'DELETE', headers: connectorKeyHeaders },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(sql).toHaveBeenCalledTimes(3) // 2 (auth) + getSource, stopped before any deletion
  })
})
