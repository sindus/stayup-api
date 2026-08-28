import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const authRoute = new Hono<{ Bindings: Bindings }>()

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

  // Connexion admin : `username` porte l'e-mail du compte admin (table `admin`),
  // vérifié contre son hash. Plus de mot de passe en dur dans l'environnement.
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
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const { id: userId, name, email, password: passwordHash } = account

  const valid = await compare(body.password, passwordHash)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  // Le token porte l'e-mail stocké, pas celui saisi : sinon sa casse varie d'une
  // connexion à l'autre et les clients affichent deux identités pour un seul compte.
  const token = await sign(
    userTokenPayload(userId, name, email),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token })
})

// GET /auth/me — renvoie l'identité portée par le token, après vérification de sa
// signature et de son expiration. Les clients qui ne connaissent pas JWT_SECRET
// (stayup-ui) s'en servent pour valider une session au lieu de faire confiance au
// payload non signé qu'ils savent seulement décoder.
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
  const created = await store.createCredentialUser({
    name: body.name,
    email: normalizeEmail(body.email),
    passwordHash: await hash(body.password, 10),
  })

  if (!created) {
    return c.json({ error: 'Email already in use' }, 409)
  }

  const token = await sign(
    userTokenPayload(created.id, body.name, normalizeEmail(body.email)),
    c.env.JWT_SECRET,
    'HS256',
  )

  return c.json({ token }, 201)
})
