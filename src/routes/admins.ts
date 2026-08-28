import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
import {
  authMiddleware,
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const adminsRoute = new Hono<{ Bindings: Bindings }>()

adminsRoute.use('*', authMiddleware)

// ─── Self-service : un admin change son propre mot de passe ──────────────────

// PATCH /ui/admins/me — { currentPassword, password }
adminsRoute.patch('/me', requireAdmin, async (c) => {
  const payload = c.get('jwtPayload') as { sub?: string }
  const adminId = payload?.sub
  if (!adminId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{
    currentPassword?: string
    password?: string
  }>()
  if (!body.currentPassword || !body.password) {
    return c.json({ error: 'currentPassword and password are required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const me = await store.getAdmin(adminId)
  if (!me) return c.json({ error: 'Admin not found' }, 404)

  const account = await store.findAdminByEmail(normalizeEmail(me.email))
  if (
    !account ||
    !(await compare(body.currentPassword, account.password_hash))
  ) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  await store.updateAdmin(adminId, {
    passwordHash: await hash(body.password, 10),
  })
  return c.json({ success: true })
})

// ─── Super admin uniquement : gestion des autres admins ─────────────────────

adminsRoute.use('*', requireSuperAdmin)

// GET /ui/admins
adminsRoute.get('/', async (c) => {
  const admins = await (await getStore(c.env.DATABASE_URL)).listAdmins()
  return c.json({ admins })
})

// POST /ui/admins — { email, name, password }. Crée un admin « normal » : les
// super admins ne se créent qu'en ligne de commande.
adminsRoute.post('/', async (c) => {
  const body = await c.req.json<{
    email?: string
    name?: string
    password?: string
  }>()
  if (!body.email || !body.name || !body.password) {
    return c.json({ error: 'email, name and password are required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const created = await store.createAdmin({
    email: normalizeEmail(body.email),
    name: body.name,
    passwordHash: await hash(body.password, 10),
    isSuper: false,
  })
  if (!created) return c.json({ error: 'Email already in use' }, 409)

  return c.json(
    {
      admin: {
        id: created.id,
        email: normalizeEmail(body.email),
        name: body.name,
        is_super: false,
      },
    },
    201,
  )
})

// PATCH /ui/admins/:id — { name?, email?, password? }
adminsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    email?: string
    password?: string
  }>()

  const store = await getStore(c.env.DATABASE_URL)
  const target = await store.getAdmin(id)
  if (!target) return c.json({ error: 'Admin not found' }, 404)

  try {
    await store.updateAdmin(id, {
      name: body.name,
      email: body.email === undefined ? undefined : normalizeEmail(body.email),
      passwordHash: body.password ? await hash(body.password, 10) : undefined,
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Email already in use' }, 409)
    }
    throw err
  }

  return c.json({ success: true })
})

// DELETE /ui/admins/:id
adminsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const payload = c.get('jwtPayload') as { sub?: string }

  const store = await getStore(c.env.DATABASE_URL)
  const target = await store.getAdmin(id)
  if (!target) return c.json({ error: 'Admin not found' }, 404)

  // Un super admin ne se supprime pas depuis l'interface (seulement en base) ;
  // et on ne se supprime pas soi-même.
  if (target.is_super) {
    return c.json({ error: 'Super admins cannot be removed from the UI' }, 403)
  }
  if (id === payload?.sub) {
    return c.json({ error: 'You cannot delete your own account' }, 409)
  }

  await store.deleteAdmin(id)
  return c.json({ success: true })
})
