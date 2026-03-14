import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { pool } from '../../src/db/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../src/db/schema.sql'), 'utf-8')
  await pool.query(schema)
})

afterAll(async () => {
  await pool.query(`
    DROP TABLE IF EXISTS log CASCADE;
    DROP TABLE IF EXISTS connector_youtube CASCADE;
    DROP TABLE IF EXISTS connector_changelog CASCADE;
    DROP TABLE IF EXISTS profile CASCADE;
    DROP TABLE IF EXISTS repository CASCADE;
  `)
  await pool.end()
})

describe('GET /', () => {
  it('returns health check', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok' })
  })
})

describe('GET /connectors', () => {
  it('returns connector tables', async () => {
    const res = await app.request('/connectors')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('connectors')
    expect(body.connectors).toHaveProperty('connector_changelog')
    expect(body.connectors).toHaveProperty('connector_youtube')
  })

  it('returns empty arrays for empty connector tables', async () => {
    const res = await app.request('/connectors')
    const body = await res.json()
    expect(Array.isArray(body.connectors.connector_changelog)).toBe(true)
    expect(body.connectors.connector_changelog).toHaveLength(0)
  })
})

describe('GET /connectors/:name', () => {
  it('returns data for connector_changelog', async () => {
    const res = await app.request('/connectors/connector_changelog')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connector).toBe('connector_changelog')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns data for connector_youtube', async () => {
    const res = await app.request('/connectors/connector_youtube')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connector).toBe('connector_youtube')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns 404 for unknown connector', async () => {
    const res = await app.request('/connectors/connector_unknown')
    expect(res.status).toBe(404)
  })

  it('returns 404 for non-connector table', async () => {
    const res = await app.request('/connectors/repository')
    expect(res.status).toBe(404)
  })
})
