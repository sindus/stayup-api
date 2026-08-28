import { hash } from 'bcryptjs'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, authHeaders, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

const superHeaders = () => authHeaders('admin', 'root@stayup.test', true)
const plainAdminHeaders = () => authHeaders('admin', 'ops@stayup.test', false)

const ADMIN_ROW = {
  id: 'adm-2',
  email: 'ops@stayup.test',
  name: 'Ops',
  is_super: false,
  created_at: new Date().toISOString(),
}

describe('/ui/admins — super-admin only', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403 for a non-super admin', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/admins',
      { headers: await plainAdminHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('403 for a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/admins',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('lists admins for a super admin', async () => {
    mockSql([[ADMIN_ROW]])
    const res = await app.request(
      '/ui/admins',
      { headers: await superHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.admins[0].email).toBe('ops@stayup.test')
  })

  it('creates a (non-super) admin', async () => {
    mockSql([[]]) // INSERT admin
    const res = await app.request(
      '/ui/admins',
      {
        method: 'POST',
        headers: {
          ...(await superHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'New@Stayup.test',
          name: 'New',
          password: 'pw',
        }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.admin.email).toBe('new@stayup.test')
    expect(body.admin.is_super).toBe(false)
  })

  it('409 when the e-mail is taken', async () => {
    const sql = mockSql([])
    sql.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
    )
    const res = await app.request(
      '/ui/admins',
      {
        method: 'POST',
        headers: {
          ...(await superHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@b.c', name: 'X', password: 'pw' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('404 patching an unknown admin', async () => {
    mockSql([[]]) // getAdmin → none
    const res = await app.request(
      '/ui/admins/nope',
      {
        method: 'PATCH',
        headers: {
          ...(await superHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })

  it('refuses to delete a super admin from the UI', async () => {
    mockSql([[{ ...ADMIN_ROW, is_super: true }]])
    const res = await app.request(
      '/ui/admins/adm-1',
      { method: 'DELETE', headers: await superHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('refuses to delete yourself', async () => {
    // token sub is '1' (see helpers.bearerToken)
    mockSql([[{ ...ADMIN_ROW, id: '1' }]])
    const res = await app.request(
      '/ui/admins/1',
      { method: 'DELETE', headers: await superHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(409)
  })

  it('deletes a plain admin', async () => {
    mockSql([[ADMIN_ROW], [{ id: 'adm-2' }]])
    const res = await app.request(
      '/ui/admins/adm-2',
      { method: 'DELETE', headers: await superHeaders() },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).success).toBe(true)
  })
})

describe('PATCH /ui/admins/me — self password change', () => {
  let currentHash: string
  beforeAll(async () => {
    currentHash = await hash('old-pw', 10)
  })
  beforeEach(() => vi.clearAllMocks())

  it('changes the password with the right current one', async () => {
    mockSql([
      [
        {
          id: '1',
          email: 'me@stayup.test',
          name: 'Me',
          is_super: false,
          created_at: '',
        },
      ],
      [
        {
          id: '1',
          email: 'me@stayup.test',
          name: 'Me',
          password_hash: currentHash,
          is_super: false,
        },
      ],
      [], // UPDATE
    ])
    const res = await app.request(
      '/ui/admins/me',
      {
        method: 'PATCH',
        headers: {
          ...(await plainAdminHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword: 'old-pw', password: 'new-pw' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('401 with a wrong current password', async () => {
    mockSql([
      [
        {
          id: '1',
          email: 'me@stayup.test',
          name: 'Me',
          is_super: false,
          created_at: '',
        },
      ],
      [
        {
          id: '1',
          email: 'me@stayup.test',
          name: 'Me',
          password_hash: currentHash,
          is_super: false,
        },
      ],
    ])
    const res = await app.request(
      '/ui/admins/me',
      {
        method: 'PATCH',
        headers: {
          ...(await plainAdminHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword: 'nope', password: 'new-pw' }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })
})
