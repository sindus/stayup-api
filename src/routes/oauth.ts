import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import { getSql } from '../db/client.js'
import type { Bindings } from '../types.js'

export const oauthRoute = new Hono<{ Bindings: Bindings }>()

function userTokenPayload(userId: string, name: string, email: string) {
  return {
    sub: userId,
    role: 'user',
    name,
    email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  }
}

// ─── Google ──────────────────────────────────────────────────────────────────

oauthRoute.get('/oauth/google', async (c) => {
  const state = await sign(
    { provider: 'google', exp: Math.floor(Date.now() / 1000) + 300 },
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

  try {
    await verify(state, c.env.JWT_SECRET, 'HS256')
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
    name: string
  }

  const sql = getSql(c.env.DATABASE_URL)
  const token = await findOrCreateOAuthUser(
    sql,
    'google',
    profile.id,
    profile.email,
    profile.name,
    c.env.JWT_SECRET,
  )

  return c.redirect(`${c.env.UI_URL}/api/auth/callback?token=${token}`)
})

// ─── GitHub ───────────────────────────────────────────────────────────────────

oauthRoute.get('/oauth/github', async (c) => {
  const state = await sign(
    { provider: 'github', exp: Math.floor(Date.now() / 1000) + 300 },
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

  try {
    await verify(state, c.env.JWT_SECRET, 'HS256')
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
    email =
      emails.find((e) => e.primary && e.verified)?.email ??
      emails.find((e) => e.verified)?.email ??
      emails[0]?.email ??
      ''
  }

  const sql = getSql(c.env.DATABASE_URL)
  const token = await findOrCreateOAuthUser(
    sql,
    'github',
    String(profile.id),
    email,
    profile.name ?? profile.login,
    c.env.JWT_SECRET,
  )

  return c.redirect(`${c.env.UI_URL}/api/auth/callback?token=${token}`)
})

// ─── Shared helper ────────────────────────────────────────────────────────────

async function findOrCreateOAuthUser(
  sql: ReturnType<typeof getSql>,
  provider: string,
  providerAccountId: string,
  email: string,
  name: string,
  jwtSecret: string,
): Promise<string> {
  const now = new Date().toISOString()

  // Check if OAuth account exists
  const [existing] = await sql<{ user_id: string }[]>`
    SELECT user_id FROM account
    WHERE provider_id = ${provider} AND account_id = ${providerAccountId}
    LIMIT 1
  `

  let userId: string
  let resolvedName: string
  let resolvedEmail: string

  if (existing) {
    userId = existing.user_id
    const [u] = await sql<{ name: string; email: string }[]>`
      SELECT name, email FROM "user" WHERE id = ${userId}
    `
    resolvedName = u?.name ?? name
    resolvedEmail = u?.email ?? email
  } else {
    // Check if user with same email exists
    const [byEmail] = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM "user" WHERE email = ${email} LIMIT 1
    `

    if (byEmail) {
      userId = byEmail.id
      resolvedName = byEmail.name
      resolvedEmail = email
    } else {
      userId = crypto.randomUUID()
      resolvedName = name
      resolvedEmail = email
      await sql`
        INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
        VALUES (${userId}, ${name}, ${email}, ${now}, ${now}, true)
      `
    }

    await sql`
      INSERT INTO account (id, user_id, provider_id, account_id, created_at, updated_at)
      VALUES (
        ${crypto.randomUUID()},
        ${userId},
        ${provider},
        ${providerAccountId},
        ${now},
        ${now}
      )
    `
  }

  return sign(
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
}
