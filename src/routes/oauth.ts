import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import type { DataStore } from '../db/port.js'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
import { type Bindings, registrationMode } from '../types.js'

export const oauthRoute = new Hono<{ Bindings: Bindings }>()

// ─── Google ──────────────────────────────────────────────────────────────────

oauthRoute.get('/oauth/google', async (c) => {
  const mobileRedirectUri = c.req.query('redirect_uri') ?? null
  // Valeur opaque choisie par le client : renvoyée telle quelle après OAuth
  // (`&state=`), pour qu'une app multi-instance rattache le token à l'instance
  // qui a lancé le flux. Scellée dans le state signé, donc non falsifiable.
  const clientState = c.req.query('client_state') ?? null

  const state = await sign(
    {
      provider: 'google',
      exp: Math.floor(Date.now() / 1000) + 300,
      ...(mobileRedirectUri ? { redirect_uri: mobileRedirectUri } : {}),
      ...(clientState ? { client_state: clientState } : {}),
    },
    c.env.JWT_SECRET,
    'HS256',
  )

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${new URL(c.req.url).origin}/auth/oauth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  })

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

oauthRoute.get('/oauth/google/callback', async (c) => {
  const { code, state } = c.req.query()

  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400)

  let statePayload: { redirect_uri?: string; client_state?: string }
  try {
    statePayload = (await verify(state, c.env.JWT_SECRET, 'HS256')) as {
      redirect_uri?: string
      client_state?: string
    }
  } catch {
    return c.json({ error: 'Invalid state' }, 400)
  }

  const origin = new URL(c.req.url).origin
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/auth/oauth/google/callback`,
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) return c.json({ error: 'Token exchange failed' }, 502)

  const { access_token } = (await tokenRes.json()) as { access_token: string }

  const profileRes = await fetch(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${access_token}` } },
  )
  if (!profileRes.ok) return c.json({ error: 'Profile fetch failed' }, 502)

  const profile = (await profileRes.json()) as {
    id: string
    email: string
    verified_email?: boolean
    name: string
  }

  const store = await getStore(c.env.DATABASE_URL)
  const result = await findOrCreateOAuthUser(
    store,
    'google',
    profile.id,
    // Un e-mail non vérifié ne doit jamais servir à retrouver un compte existant.
    profile.verified_email === false ? '' : profile.email,
    profile.name,
    c.env.JWT_SECRET,
    registrationMode(c.env),
  )

  return c.redirect(
    oauthCallbackRedirect(
      c.env,
      statePayload.redirect_uri,
      result,
      statePayload.client_state,
    ),
  )
})

// ─── GitHub ───────────────────────────────────────────────────────────────────

oauthRoute.get('/oauth/github', async (c) => {
  const mobileRedirectUri = c.req.query('redirect_uri') ?? null
  const clientState = c.req.query('client_state') ?? null

  const state = await sign(
    {
      provider: 'github',
      exp: Math.floor(Date.now() / 1000) + 300,
      ...(mobileRedirectUri ? { redirect_uri: mobileRedirectUri } : {}),
      ...(clientState ? { client_state: clientState } : {}),
    },
    c.env.JWT_SECRET,
    'HS256',
  )

  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${new URL(c.req.url).origin}/auth/oauth/github/callback`,
    scope: 'read:user user:email',
    state,
  })

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`)
})

oauthRoute.get('/oauth/github/callback', async (c) => {
  const { code, state } = c.req.query()

  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400)

  let statePayload: { redirect_uri?: string; client_state?: string }
  try {
    statePayload = (await verify(state, c.env.JWT_SECRET, 'HS256')) as {
      redirect_uri?: string
      client_state?: string
    }
  } catch {
    return c.json({ error: 'Invalid state' }, 400)
  }

  const origin = new URL(c.req.url).origin
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/auth/oauth/github/callback`,
    }),
  })

  if (!tokenRes.ok) return c.json({ error: 'Token exchange failed' }, 502)

  const { access_token } = (await tokenRes.json()) as { access_token: string }

  const [profileRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'User-Agent': 'StayUp',
      },
    }),
    fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'User-Agent': 'StayUp',
      },
    }),
  ])

  if (!profileRes.ok) return c.json({ error: 'Profile fetch failed' }, 502)

  const profile = (await profileRes.json()) as {
    id: number
    login: string
    name: string | null
  }

  let email = ''
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as {
      email: string
      primary: boolean
      verified: boolean
    }[]
    // Uniquement des adresses vérifiées : GitHub laisse ajouter n'importe quelle
    // adresse à un compte sans la prouver, et l'ancien repli `emails[0]` permettait
    // donc de se faire rattacher au compte StayUp d'un tiers.
    email =
      emails.find((e) => e.primary && e.verified)?.email ??
      emails.find((e) => e.verified)?.email ??
      ''
  }

  const store = await getStore(c.env.DATABASE_URL)
  const result = await findOrCreateOAuthUser(
    store,
    'github',
    String(profile.id),
    email,
    profile.name ?? profile.login,
    c.env.JWT_SECRET,
    registrationMode(c.env),
  )

  return c.redirect(
    oauthCallbackRedirect(
      c.env,
      statePayload.redirect_uri,
      result,
      statePayload.client_state,
    ),
  )
})

// ─── Shared helper ────────────────────────────────────────────────────────────

/** Construit l'URL de retour après OAuth : `?token=` en succès, ou
 *  `?error=pending_approval` si le compte attend une validation admin. Si le
 *  client a fourni un `client_state`, il est renvoyé tel quel en `&state=`. */
function oauthCallbackRedirect(
  env: Bindings,
  redirectUri: string | undefined,
  result: { token: string } | { pending: true },
  clientState?: string,
): string {
  const base = isMobileRedirectUri(redirectUri)
    ? redirectUri
    : `${env.UI_URL}/api/auth/callback`
  const parts = [
    'pending' in result ? 'error=pending_approval' : `token=${result.token}`,
  ]
  if (clientState) parts.push(`state=${encodeURIComponent(clientState)}`)
  return `${base}?${parts.join('&')}`
}

// L'URI de retour est fournie par l'appelant *avant* la signature du state : la
// signer ne la rend donc pas fiable. Sans liste blanche, `exp://n-importe-quel-hote`
// suffit à faire livrer le token de la victime chez un tiers.
//
// - `stayup://auth/callback` : le schéma de l'app installée (app.json), URI exacte.
// - `exp://<hote>:<port>/--/auth/callback` : Expo Go en développement, où l'hôte est
//   la machine du développeur — donc restreint à la boucle locale et aux plages IP
//   privées, jamais à un hôte public.
const STANDALONE_REDIRECT_URI = 'stayup://auth/callback'
const EXPO_GO_PATH = '/--/auth/callback'

function isPrivateHostname(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  ) {
    return true
  }
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function isMobileRedirectUri(uri: string | undefined): uri is string {
  if (!uri) return false
  if (uri === STANDALONE_REDIRECT_URI) return true
  if (!uri.startsWith('exp://')) return false
  try {
    const parsed = new URL(uri)
    return (
      parsed.pathname === EXPO_GO_PATH && isPrivateHostname(parsed.hostname)
    )
  } catch {
    return false
  }
}

async function findOrCreateOAuthUser(
  store: DataStore,
  provider: string,
  providerAccountId: string,
  email: string,
  name: string,
  jwtSecret: string,
  mode: 'open' | 'approval',
): Promise<{ token: string } | { pending: true }> {
  // Check if OAuth account exists
  const existing = await store.findOAuthAccount(provider, providerAccountId)

  let userId: string
  let resolvedName: string
  let resolvedEmail: string

  if (existing) {
    userId = existing.user_id
    const identity = await store.getUserIdentity(userId)
    resolvedName = identity?.name ?? name
    resolvedEmail = identity?.email ?? email
  } else {
    const verifiedEmail = normalizeEmail(email)

    // Sans e-mail vérifié, on ne rattache rien : on ouvre un compte neuf avec une
    // adresse de repli unique, sinon l'unicité de l'e-mail rejette le deuxième
    // inscrit sans e-mail et tous se retrouveraient sur le même compte.
    const byEmail = verifiedEmail
      ? await store.findUserByEmail(verifiedEmail)
      : null

    if (byEmail) {
      // L'e-mail vérifié correspond à un compte déjà actif : on lie ce provider
      // à ce compte, aucune validation à demander.
      userId = byEmail.id
      resolvedName = byEmail.name
      resolvedEmail = verifiedEmail
    } else {
      resolvedEmail =
        verifiedEmail || `${provider}-${providerAccountId}@users.noreply.stayup`

      // Identité neuve + mode `approval` : on met en attente au lieu de créer le
      // compte. La ligne stocke le provider pour que la validation admin puisse
      // recréer l'identité à l'identique. Un doublon (déjà en attente) est un
      // no-op : le résultat est le même, « en attente ».
      if (mode === 'approval') {
        await store.createPendingUser({
          name,
          email: resolvedEmail,
          oauthProvider: provider,
          oauthAccountId: providerAccountId,
        })
        return { pending: true }
      }

      resolvedName = name
      userId = (
        await store.createOAuthUser({
          name,
          email: resolvedEmail,
          emailVerified: Boolean(verifiedEmail),
        })
      ).id
    }

    await store.linkOAuthAccount(userId, provider, providerAccountId)
  }

  const token = await sign(
    {
      sub: userId,
      role: 'user',
      name: resolvedName,
      email: resolvedEmail,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    jwtSecret,
    'HS256',
  )
  return { token }
}
