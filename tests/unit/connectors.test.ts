import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
}))

import { getPool } from '../../src/db/client.js'

describe('GET /connectors (auth)', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/connectors', {}, TEST_ENV)
    expect(res.status).toBe(401)
  })
})

describe('GET /connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all connector tables data', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ table_name: 'connector_changelog' }, { table_name: 'connector_youtube' }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 1, content: 'changelog entry' }] })
        .mockResolvedValueOnce({ rows: [{ id: 2, content: 'youtube video' }] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const res = await app.request('/connectors', { headers: await authHeaders('user') }, TEST_ENV)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.connectors).toHaveProperty('changelog')
    expect(body.connectors).toHaveProperty('youtube')
    expect(body.connectors.changelog).toEqual([{ id: 1, content: 'changelog entry' }])
    expect(body.connectors.youtube).toEqual([{ id: 2, content: 'youtube video' }])
  })

  it('returns empty object when no connector tables exist', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const res = await app.request('/connectors', { headers: await authHeaders('user') }, TEST_ENV)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.connectors).toEqual({})
  })

  it('releases client even on error', async () => {
    const mockClient = {
      query: vi.fn().mockRejectedValueOnce(new Error('DB error')),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    await app.request('/connectors', { headers: await authHeaders('user') }, TEST_ENV)
    expect(mockClient.release).toHaveBeenCalled()
  })
})

describe('GET /connectors/latest (auth)', () => {
  it('returns 403 for non-admin user', async () => {
    const mockClient = { query: vi.fn(), release: vi.fn() }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /connectors/latest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns latest entry per provider_id for all connectors', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ table_name: 'connector_changelog' }, { table_name: 'connector_youtube' }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 2, provider_id: 1, content: 'latest changelog' }] })
        .mockResolvedValueOnce({ rows: [{ id: 4, provider_id: 1, content: 'latest video' }] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.latest).toHaveProperty('changelog')
    expect(body.latest).toHaveProperty('youtube')
    expect(body.latest.changelog).toEqual([{ id: 2, provider_id: 1, content: 'latest changelog' }])
    expect(body.latest.youtube).toEqual([{ id: 4, provider_id: 1, content: 'latest video' }])
  })

  it('returns empty object when no connector tables exist', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const res = await app.request(
      '/connectors/latest',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.latest).toEqual({})
  })
})

describe('GET /connectors/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns latest per provider_id for a specific connector', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ table_name: 'connector_changelog' }] })
        .mockResolvedValueOnce({ rows: [{ id: 2, provider_id: 1, content: 'latest' }] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

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
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const res = await app.request(
      '/connectors/unknown',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
