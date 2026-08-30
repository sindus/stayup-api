import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

const adminReq = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  app.request(
    path,
    { ...init, headers: { ...(await authHeaders('admin')), ...init.headers } },
    TEST_ENV,
  )

beforeEach(() => vi.clearAllMocks())

describe('GET /ui/data-sources', () => {
  it('requires an admin', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/data-sources',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns the primary info and an empty secondary list', async () => {
    // ensureMultiDbTables (unsafe) ; SELECT data_source → none
    mockSql([undefined, []])
    const res = await adminReq('/ui/data-sources')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.primary.engine).toBe('postgres')
    expect(body.sources).toEqual([])
  })
})

describe('POST /ui/data-sources/test', () => {
  it('reports the engine and the connectors it finds', async () => {
    // listProviderNames → information_schema rows
    mockSql([
      [{ table_name: 'connector_rss' }, { table_name: 'connector_youtube' }],
    ])
    const res = await adminReq('/ui/data-sources/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'postgres://u:p@host:5432/db' }),
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      ok: true,
      engine: 'postgres',
      connectors: ['rss', 'youtube'],
    })
  })

  it('rejects an unsupported scheme', async () => {
    mockSql([])
    const res = await adminReq('/ui/data-sources/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'redis://host:6379' }),
    })
    expect((await json(res)).ok).toBe(false)
  })
})

describe('POST /ui/data-sources', () => {
  it('stores a source once its probe finds a connector', async () => {
    // probe listProviderNames ; ensureMultiDbTables (unsafe) ; INSERT RETURNING
    mockSql([[{ table_name: 'connector_rss' }], undefined, [{ id: 7 }]])
    const res = await adminReq('/ui/data-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Cluster A',
        url: 'postgres://u:p@host/db',
      }),
    })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.dataSource).toMatchObject({
      id: 7,
      name: 'Cluster A',
      engine: 'postgres',
      host: 'host',
      connectors: ['rss'],
    })
  })

  it('refuses a database with no connector table', async () => {
    mockSql([[]]) // probe finds nothing
    const res = await adminReq('/ui/data-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty', url: 'postgres://u:p@host/db' }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/connector/i)
  })

  it('validates the body', async () => {
    mockSql([])
    const res = await adminReq('/ui/data-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no url' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /ui/data-sources/:id', () => {
  it('removes a source', async () => {
    // ensureMultiDbTables (unsafe) ; DELETE RETURNING → one row
    mockSql([undefined, [{ id: 3 }]])
    const res = await adminReq('/ui/data-sources/3', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
  })

  it('404s for an unknown id', async () => {
    mockSql([undefined, []])
    const res = await adminReq('/ui/data-sources/99', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
