import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import {
  TEST_ENV,
  authHeaders,
  createSqlMock,
  json,
  mockSql,
} from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({
  getSql: vi.fn(),
}))

import { getSql } from '../../src/db/client.js'

describe('GET /connectors/providers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns discovered providers enriched with their display name', async () => {
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ name: 'changelog' }, { name: 'youtube' }]) // listProviderNames: registeredNames
      .mockResolvedValueOnce([]) // listProviderNames: namesWithContent
      .mockResolvedValueOnce([
        { name: 'youtube', display_name: 'YouTube', sort_order: 20 },
      ]) // readRegistry (pas de ligne pour 'changelog' → fallback)
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.providers).toEqual([
      { name: 'youtube', displayName: 'YouTube', fluxApproval: 'auto' },
      { name: 'changelog', displayName: 'Changelog', fluxApproval: 'auto' },
    ])
  })

  it('returns an empty list when provider_registry does not exist yet', async () => {
    // Base neuve : aucun connector ne s'est encore jamais enregistré.
    const sql = createSqlMock()
    sql.mockRejectedValueOnce(
      new Error('relation "provider_registry" does not exist'),
    )
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).providers).toEqual([])
  })

  it('returns an empty list when no provider is registered', async () => {
    const sql = createSqlMock()
    sql.mockResolvedValueOnce([])
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).providers).toEqual([])
  })

  it('relays the display template a provider declares, unchanged', async () => {
    const template = {
      version: 1,
      display: { name: 'GitHub Trending', accent: '#f4b585' },
      list: { layout: 'row', primary: 'title' },
      detail: { mode: 'table', collection: 'repos' },
    }
    const sql = createSqlMock()
    sql
      .mockResolvedValueOnce([{ name: 'github_trending' }, { name: 'youtube' }]) // listProviderNames: registeredNames
      .mockResolvedValueOnce([]) // listProviderNames: namesWithContent
      .mockResolvedValueOnce([
        {
          name: 'github_trending',
          display_name: 'GitHub Trending',
          sort_order: 50,
          template,
        },
        // youtube : pas de template déclaré → clé absente de la réponse
        { name: 'youtube', display_name: 'YouTube', sort_order: 20 },
      ]) // readRegistry
    vi.mocked(getSql).mockReturnValue(sql as never)

    const res = await app.request(
      '/connectors/providers',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).providers).toEqual([
      { name: 'youtube', displayName: 'YouTube', fluxApproval: 'auto' },
      {
        name: 'github_trending',
        displayName: 'GitHub Trending',
        fluxApproval: 'auto',
        template,
      },
    ])
  })
})

describe('GET /connectors (auth)', () => {
  it('returns 401 without token', async () => {
    mockSql([])
    const res = await app.request('/connectors', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })
})

describe('GET /connectors', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns all providers content, keyed by provider', async () => {
    // listProviderNames (registeredNames, namesWithContent) ;
    // allContent(changelog) ; allContent(youtube)
    mockSql([
      [{ name: 'changelog' }, { name: 'youtube' }],
      [],
      [{ id: 1, content: 'changelog entry' }],
      [{ id: 2, content: 'youtube video' }],
    ])

    const res = await app.request(
      '/connectors',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)

    const body = await json(res)
    expect(body.connectors).toHaveProperty('changelog')
    expect(body.connectors).toHaveProperty('youtube')
  })

  it('returns an empty object when no provider is registered', async () => {
    mockSql([[]])

    const res = await app.request(
      '/connectors',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.connectors).toEqual({})
  })
})

describe('GET /connectors/latest (auth)', () => {
  it('returns 403 for non-admin user', async () => {
    mockSql([[]])

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

  it('returns the latest entry per repository_id for all providers', async () => {
    // listProviderNames (registeredNames, namesWithContent) ;
    // latestPerSource(changelog) ; latestPerSource(youtube)
    mockSql([
      [{ name: 'changelog' }, { name: 'youtube' }],
      [],
      [{ id: 2, repository_id: 1, content: 'latest changelog' }],
      [{ id: 4, repository_id: 1, content: 'latest video' }],
    ])

    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.latest.changelog).toEqual([
      { id: 2, repository_id: 1, content: 'latest changelog' },
    ])
    expect(body.latest.youtube).toEqual([
      { id: 4, repository_id: 1, content: 'latest video' },
    ])
  })
})

describe('GET /connectors/:name', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the latest entry per source for a specific provider', async () => {
    // providerExists ; latestPerSource
    mockSql([
      [{ name: 'changelog' }],
      [{ id: 2, repository_id: 1, content: 'latest' }],
    ])

    const res = await app.request(
      '/connectors/changelog',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.connector).toBe('changelog')
    expect(body.data).toEqual([{ id: 2, repository_id: 1, content: 'latest' }])
  })

  it('returns 404 for an unregistered provider', async () => {
    mockSql([[]]) // providerExists → false

    const res = await app.request(
      '/connectors/unknown',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
