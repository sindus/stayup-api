import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
import { authMiddleware } from '../middleware/auth.js'
import { type Bindings, registrationMode } from '../types.js'

export const authRoute = new Hono<{ Bindings: Bindings }>()

// GET /auth/config — what a client needs to know before showing the login
// screen: registration mode, and which login methods this instance offers.
// Public, unauthenticated — a client uses it precisely to choose which API to
// connect to.
authRoute.get('/config', (c) => {
  return c.json({
    // Human-readable instance label (INSTANCE_NAME). `null` if unset: apps then
    // fall back to the URL's host.
    name: c.env.INSTANCE_NAME || null,
    registrationMode: registrationMode(c.env),
    emailPassword: true,
    oauth: {
      google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
      github: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    },
  })
})

function userTokenPayload(userId: string, name: string, email: string) {
  return {
    sub: userId,
    role: 'user',
    name,
    email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  }
}

// POST /auth/login
authRoute.post('/login', async (c) => {
  const body = await c.req.json<{
    username?: string
    email?: string
    password: string
  }>()

  // Admin login: `username` carries the admin account's e-mail (table `admin`),
  // checked against its hash. No more hardcoded password in the environment.
  if (body.username) {
    const store = await getStore(c.env.DATABASE_URL)
    const admin = await store.findAdminByEmail(normalizeEmail(body.username))
    if (!admin || !(await compare(body.password, admin.password_hash))) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const token = await sign(
      {
        sub: admin.id,
        role: 'admin',
        is_super: admin.is_super,
        name: admin.name,
        email: admin.email,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
      },
      c.env.JWT_SECRET,
      'HS256',
    )

    return c.json({ token })
  }

  // User login via email + password
  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const account = await store.findCredentialByEmail(normalizeEmail(body.email))

  if (!account) {
    // Account created in `approval` mode but not yet approved: it is not in
    // `user`, so `findCredentialByEmail` does not see it. We say so clearly
    // rather than "invalid credentials", which would send the user re-typing a
    // correct password over and over.
    const pending = await store.findPendingUserByEmail(
      normalizeEmail(body.email),
    )
    if (pending) {
      return c.json({ error: 'pending_approval' }, 403)
    }
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const { id: userId, name, email, password: passwordHash } = account

  const valid = await compare(body.password, passwordHash)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  // The token carries the stored e-mail, not the typed one: otherwise its case
  // varies from one login to the next and clients show two identities for a
  // single account.
  const token = await sign(
    userTokenPayload(userId, name, email),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token })
})

// GET /auth/me — returns the identity carried by the token, after verifying its
// signature and expiration. Clients that do not know JWT_SECRET (stayup-ui) use
// it to validate a session instead of trusting the unsigned payload they can
// only decode.
authRoute.get('/me', authMiddleware, async (c) => {
  const payload = c.get('jwtPayload') as {
    sub?: string
    role?: string
    is_super?: boolean
    name?: string
    email?: string
  }
  return c.json({
    userId: payload.sub ?? '',
    role: payload.role ?? 'user',
    isSuper: payload.is_super === true,
    name: payload.name ?? '',
    email: payload.email ?? '',
  })
})

// POST /auth/register (public)
authRoute.post('/register', async (c) => {
  const body = await c.req.json<{
    name: string
    email: string
    password: string
  }>()

  if (!body.name || !body.email || !body.password) {
    return c.json({ error: 'name, email and password are required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const email = normalizeEmail(body.email)
  const passwordHash = await hash(body.password, 10)

  // `approval` mode: the account is not created, it is put on hold. No token —
  // the user cannot log in before an admin approves it.
  if (registrationMode(c.env) === 'approval') {
    if (await store.findUserByEmail(email)) {
      return c.json({ error: 'Email already in use' }, 409)
    }
    const pending = await store.createPendingUser({
      name: body.name,
      email,
      passwordHash,
    })
    if (!pending) {
      return c.json({ error: 'Email already in use' }, 409)
    }
    return c.json({ status: 'pending_approval' }, 202)
  }

  const created = await store.createCredentialUser({
    name: body.name,
    email,
    passwordHash,
  })

  if (!created) {
    return c.json({ error: 'Email already in use' }, 409)
  }

  const token = await sign(
    userTokenPayload(created.id, body.name, email),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token }, 201)
})
