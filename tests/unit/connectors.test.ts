import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({
  getSql: vi.fn(),
}))

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

describe('GET /connectors (auth)', () => {
  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/connectors', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })
})

describe('GET /connectors', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns all connector tables data', async () => {
    const sql = vi.fn()
    sql.unsafe = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, content: 'changelog entry' }])
      .mockResolvedValueOnce([{ id: 2, content: 'youtube video' }])
    sql.mockResolvedValueOnce([
      { table_name: 'connector_changelog' },
      { table_name: 'connector_youtube' },
    ])
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.connectors).toHaveProperty('changelog')
    expect(body.connectors).toHaveProperty('youtube')
  })

  it('returns empty object when no connector tables exist', async () => {
    const sql = vi.fn().mockResolvedValueOnce([])
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connectors).toEqual({})
  })
})

describe('GET /connectors/latest (auth)', () => {
  it('returns 403 for non-admin user', async () => {
    const sql = vi.fn().mockResolvedValue([])
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /connectors/latest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns latest entry per provider_id for all connectors', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        { table_name: 'connector_changelog' },
        { table_name: 'connector_youtube' },
      ])
      .mockResolvedValueOnce([
        { column_name: 'provider_id' },
        { column_name: 'executed_at' },
      ]) // getTableColumns: connector_changelog
      .mockResolvedValueOnce([
        { column_name: 'provider_id' },
        { column_name: 'executed_at' },
      ]) // getTableColumns: connector_youtube
    sql.unsafe = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 2, provider_id: 1, content: 'latest changelog' },
      ])
      .mockResolvedValueOnce([
        { id: 4, provider_id: 1, content: 'latest video' },
      ])
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.latest.changelog).toEqual([
      { id: 2, provider_id: 1, content: 'latest changelog' },
    ])
    expect(body.latest.youtube).toEqual([
      { id: 4, provider_id: 1, content: 'latest video' },
    ])
  })
})

describe('GET /connectors/:name', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns latest per provider_id for a specific connector', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ table_name: 'connector_changelog' }]) // exists check
      .mockResolvedValueOnce([
        { column_name: 'provider_id' },
        { column_name: 'executed_at' },
      ]) // getTableColumns
    sql.unsafe = vi
      .fn()
      .mockResolvedValueOnce([{ id: 2, provider_id: 1, content: 'latest' }])
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/changelog',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connector).toBe('changelog')
    expect(body.data).toEqual([{ id: 2, provider_id: 1, content: 'latest' }])
  })

  it('returns 404 for unknown connector', async () => {
    const sql = vi.fn().mockResolvedValueOnce([])
    sql.unsafe = vi.fn()
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/unknown',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
