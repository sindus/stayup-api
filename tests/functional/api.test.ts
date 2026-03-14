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
    expect(body.connectors).toHaveProperty('changelog')
    expect(body.connectors).toHaveProperty('youtube')
  })

  it('returns empty arrays for empty connector tables', async () => {
    const res = await app.request('/connectors')
    const body = await res.json()
    expect(Array.isArray(body.connectors.changelog)).toBe(true)
    expect(body.connectors.changelog).toHaveLength(0)
  })
})

describe('GET /connectors/latest', () => {
  it('returns latest per provider_id for all connectors', async () => {
    const res = await app.request('/connectors/latest')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('latest')
    expect(body.latest).toHaveProperty('changelog')
    expect(body.latest).toHaveProperty('youtube')
    expect(Array.isArray(body.latest.changelog)).toBe(true)
    expect(Array.isArray(body.latest.youtube)).toBe(true)
  })
})

describe('GET /connectors/:name', () => {
  it('returns data for changelog', async () => {
    const res = await app.request('/connectors/changelog')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connector).toBe('changelog')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns data for youtube', async () => {
    const res = await app.request('/connectors/youtube')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connector).toBe('youtube')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns 404 for unknown connector', async () => {
    const res = await app.request('/connectors/unknown')
    expect(res.status).toBe(404)
  })

  it('returns 404 for non-connector table', async () => {
    const res = await app.request('/connectors/repository')
    expect(res.status).toBe(404)
  })
})
