import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
import { authMiddleware } from '../middleware/auth.js'
import { type Bindings, registrationMode } from '../types.js'

export const authRoute = new Hono<{ Bindings: Bindings }>()

// GET /auth/config — ce qu'un client doit savoir avant de montrer l'écran de
// connexion : mode d'inscription, et quelles méthodes de login cette instance
// propose. Public, non authentifié — un client s'en sert justement pour choisir
// à quelle API se connecter.
authRoute.get('/config', (c) => {
  return c.json({
    // Libellé lisible de l'instance (INSTANCE_NAME). `null` si non défini : les
    // apps retombent alors sur l'hôte de l'URL.
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
    // Compte créé en mode `approval` mais pas encore validé : il n'est pas dans
    // `user`, donc `findCredentialByEmail` ne le voit pas. On le dit clairement
    // plutôt que « identifiants invalides », qui enverrait l'utilisateur
    // ressaisir un mot de passe correct en boucle.
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
  const email = normalizeEmail(body.email)
  const passwordHash = await hash(body.password, 10)

  // Mode `approval` : le compte n'est pas créé, il est mis en attente. Pas de
  // token — l'utilisateur ne peut pas se connecter avant qu'un admin valide.
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
