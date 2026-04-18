import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

function mockSql(responses: unknown[]) {
  let call = 0
  const sql = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses[call++] ?? []))
  sql.unsafe = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses[call++] ?? []))
  vi.mocked(getSql).mockReturnValue(sql as never)
  return sql
}

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
    const body = await res.json()
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
    const body = await res.json()
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
    const sql = vi.fn().mockResolvedValueOnce([{ id: 1, type: 'changelog' }])
    sql.unsafe = vi.fn().mockResolvedValueOnce([]) // DELETE FROM connector_changelog
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/repositories/1/data',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('succeeds even when connector type has no table (e.g. unknown type)', async () => {
    const sql = vi.fn().mockResolvedValueOnce([{ id: 1, type: 'unknown' }])
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
    const sql = vi.fn().mockResolvedValueOnce([{ id: 1, type: 'rss' }])
    sql.unsafe = vi.fn().mockResolvedValueOnce([]) // DELETE connector data
    // DELETE user_repository and DELETE repository are template literal calls
    sql
      .mockResolvedValueOnce([]) // DELETE user_repository
      .mockResolvedValueOnce([]) // DELETE repository
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/ui/repositories/1',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })
})
