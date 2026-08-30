import { describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, json } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

async function config(env: typeof TEST_ENV) {
  const res = await app.request('/auth/config', {}, env)
  return { status: res.status, body: await json(res) }
}

describe('GET /auth/config', () => {
  it('reports open registration and both OAuth providers by default', async () => {
    const { status, body } = await config(TEST_ENV)
    expect(status).toBe(200)
    expect(body).toEqual({
      name: null,
      registrationMode: 'open',
      emailPassword: true,
      oauth: { google: true, github: true },
    })
  })

  it('exposes INSTANCE_NAME when set, null otherwise', async () => {
    const { body } = await config({ ...TEST_ENV, INSTANCE_NAME: 'Acme feeds' })
    expect(body.name).toBe('Acme feeds')
    const { body: unset } = await config(TEST_ENV)
    expect(unset.name).toBeNull()
  })

  it('reports approval mode when REGISTRATION_MODE=approval', async () => {
    const { body } = await config({
      ...TEST_ENV,
      REGISTRATION_MODE: 'approval',
    })
    expect(body.registrationMode).toBe('approval')
  })

  it('treats any other REGISTRATION_MODE value as open', async () => {
    const { body } = await config({
      ...TEST_ENV,
      REGISTRATION_MODE: 'nonsense',
    })
    expect(body.registrationMode).toBe('open')
  })

  it('hides an OAuth provider whose credentials are not set', async () => {
    const { body } = await config({
      ...TEST_ENV,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    })
    expect(body.oauth).toEqual({ google: false, github: true })
  })

  it('needs no authentication', async () => {
    const res = await app.request('/auth/config', {}, TEST_ENV)
    expect(res.status).toBe(200)
  })
})
