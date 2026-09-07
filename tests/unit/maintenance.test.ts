import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('POST /ui/maintenance/cleanup', () => {
  it('rejects an unknown token', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/cleanup',
      { method: 'POST', headers: { Authorization: 'Bearer nope' } },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('rejects a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/cleanup',
      { method: 'POST', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('runs the purge for the CLEANUP_SECRET bearer and reports per provider', async () => {
    mockSql([
      [{ value: '30' }], // getContentRetentionDefault
      [{ name: 'rss' }, { name: 'youtube' }], // registeredNames
      [], // namesWithContent
      [
        // readRegistry — youtube overrides retention, rss follows the default
        {
          name: 'rss',
          display_name: 'RSS',
          sort_order: 30,
          flux_approval: 'auto',
        },
        {
          name: 'youtube',
          display_name: 'YouTube',
          sort_order: 20,
          flux_approval: 'auto',
          retention_days: 7,
        },
      ],
      { count: 4 }, // DELETE for rss (30d default)
      { count: 1 }, // DELETE for youtube (7d override)
    ])

    const res = await app.request(
      '/ui/maintenance/cleanup',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ENV.CLEANUP_SECRET}` },
      },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.total).toBe(5)
    expect(body.purged).toEqual([
      { provider: 'rss', deleted: 4 },
      { provider: 'youtube', deleted: 1 },
    ])
  })

  it('purges nothing when the global default is off and no provider overrides it', async () => {
    mockSql([
      [{ value: 'off' }], // getContentRetentionDefault → null
      [{ name: 'rss' }], // registeredNames
      [], // namesWithContent
      [
        {
          name: 'rss',
          display_name: 'RSS',
          sort_order: 30,
          flux_approval: 'auto',
        },
      ],
    ])

    const res = await app.request(
      '/ui/maintenance/cleanup',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ENV.CLEANUP_SECRET}` },
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).purged).toEqual([])
  })
})

describe('GET /ui/maintenance/retention', () => {
  it('is admin-only', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/retention',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns the global default and each provider’s override', async () => {
    mockSql([
      [{ value: '45' }], // getContentRetentionDefault
      [{ name: 'rss' }], // listProviders → registeredNames
      [], // namesWithContent
      [
        {
          name: 'rss',
          display_name: 'RSS',
          sort_order: 30,
          flux_approval: 'auto',
          retention_days: 10,
        },
      ], // readRegistry
    ])

    const res = await app.request(
      '/ui/maintenance/retention',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.default).toBe(45)
    expect(body.providers).toEqual([
      { name: 'rss', displayName: 'RSS', retention_days: 10 },
    ])
  })
})

describe('PATCH /ui/maintenance/retention', () => {
  it('rejects a non-integer or zero default', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/retention',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ default: 0 }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('accepts null to disable the global default', async () => {
    mockSql([[], []]) // ensureAppSettingTable + INSERT
    const res = await app.request(
      '/ui/maintenance/retention',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ default: null }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('404s a per-provider override for an unknown provider', async () => {
    mockSql([[], []]) // providerExists: provider_registry empty, connector_item empty
    const res = await app.request(
      '/ui/maintenance/retention',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ providers: { ghost: 14 } }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
