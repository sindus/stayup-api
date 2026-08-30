import { sign } from 'hono/jwt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

function failedResponse(): Response {
  return { ok: false, json: async () => ({}) } as Response
}

// State signé comme le fait la route d'autorisation
async function signedState(
  provider: 'google' | 'github',
  redirectUri?: string,
  clientState?: string,
) {
  return sign(
    {
      provider,
      exp: Math.floor(Date.now() / 1000) + 300,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(clientState ? { client_state: clientState } : {}),
    },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  ) as Record<string, unknown>
}

function tokenFromRedirect(location: string): string {
  return new URL(location).searchParams.get('token') as string
}

// Séquence DB d'un utilisateur OAuth inédit :
// SELECT account → SELECT user par email → INSERT user → INSERT account
const NEW_USER_DB = [[], [], [], []]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

// ─── Google : redirection d'autorisation ──────────────────────────────────────

describe('GET /auth/oauth/google', () => {
  it('redirects to Google with client_id, redirect_uri and signed state', async () => {
    const res = await app.request('/auth/oauth/google', {}, TEST_ENV)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') as string)
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(location.searchParams.get('client_id')).toBe(
      TEST_ENV.GOOGLE_CLIENT_ID,
    )
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://localhost/auth/oauth/google/callback',
    )
    expect(location.searchParams.get('response_type')).toBe('code')

    const state = decodeJwt(location.searchParams.get('state') as string)
    expect(state.provider).toBe('google')
    expect(state.redirect_uri).toBeUndefined()
  })

  it('embeds redirect_uri into the state when provided (mobile deep link)', async () => {
    const res = await app.request(
      '/auth/oauth/google?redirect_uri=stayup://auth',
      {},
      TEST_ENV,
    )

    const location = new URL(res.headers.get('location') as string)
    const state = decodeJwt(location.searchParams.get('state') as string)
    expect(state.redirect_uri).toBe('stayup://auth')
  })

  it('seals an opaque client_state into the signed state when provided', async () => {
    const res = await app.request(
      '/auth/oauth/google?client_state=inst-abc',
      {},
      TEST_ENV,
    )
    const location = new URL(res.headers.get('location') as string)
    const state = decodeJwt(location.searchParams.get('state') as string)
    expect(state.client_state).toBe('inst-abc')
  })
})

// ─── Google : callback ────────────────────────────────────────────────────────

describe('GET /auth/oauth/google/callback', () => {
  it('returns 400 when code is missing', async () => {
    const state = await signedState('google')
    const res = await app.request(
      `/auth/oauth/google/callback?state=${state}`,
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Missing code or state')
  })

  it('returns 400 when state is missing', async () => {
    const res = await app.request(
      '/auth/oauth/google/callback?code=abc',
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when state is not a valid signature', async () => {
    const res = await app.request(
      '/auth/oauth/google/callback?code=abc&state=forged.token.here',
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Invalid state')
  })

  it('returns 502 when the token exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(failedResponse())
    const state = await signedState('google')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('Token exchange failed')
  })

  it('returns 502 when the profile fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(failedResponse())
    const state = await signedState('google')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('Profile fetch failed')
  })

  it('creates the user and redirects to the web UI with a token', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('google')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )

    expect(res.status).toBe(302)
    const location = res.headers.get('location') as string
    expect(location.startsWith(`${TEST_ENV.UI_URL}/api/auth/callback`)).toBe(
      true,
    )

    const payload = decodeJwt(tokenFromRedirect(location))
    expect(payload.role).toBe('user')
    expect(payload.email).toBe('alice@example.com')
    expect(payload.name).toBe('Alice')
  })

  it('redirects to the mobile deep link when the state carries one', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('google', 'stayup://auth/callback')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )

    const location = res.headers.get('location') as string
    expect(location.startsWith('stayup://auth/callback?token=')).toBe(true)
  })

  it('echoes the client_state back as &state= on the callback redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('google', undefined, 'inst-abc')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )

    const location = new URL(res.headers.get('location') as string)
    expect(location.searchParams.get('state')).toBe('inst-abc')
    expect(location.searchParams.get('token')).not.toBeNull()
  })

  it('ignores a redirect_uri that is not a known mobile scheme', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('google', 'https://evil.example.com')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )

    const location = res.headers.get('location') as string
    expect(location.startsWith('https://evil.example.com')).toBe(false)
    expect(location.startsWith(`${TEST_ENV.UI_URL}/api/auth/callback`)).toBe(
      true,
    )
  })
})

// ─── GitHub ───────────────────────────────────────────────────────────────────

describe('GET /auth/oauth/github', () => {
  it('redirects to GitHub with the expected scope', async () => {
    const res = await app.request('/auth/oauth/github', {}, TEST_ENV)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') as string)
    expect(location.origin + location.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    )
    expect(location.searchParams.get('scope')).toBe('read:user user:email')
    expect(
      decodeJwt(location.searchParams.get('state') as string).provider,
    ).toBe('github')
  })
})

describe('GET /auth/oauth/github/callback', () => {
  it('returns 400 when state is invalid', async () => {
    const res = await app.request(
      '/auth/oauth/github/callback?code=abc&state=forged',
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('returns 502 when the token exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(failedResponse())
    const state = await signedState('github')

    const res = await app.request(
      `/auth/oauth/github/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )
    expect(res.status).toBe(502)
  })

  it('picks the primary verified email and creates the user', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 42, login: 'octo', name: 'Octo' }),
      )
      .mockResolvedValueOnce(
        okResponse([
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'primary@example.com', primary: true, verified: true },
        ]),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('github')

    const res = await app.request(
      `/auth/oauth/github/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )

    expect(res.status).toBe(302)
    const payload = decodeJwt(
      tokenFromRedirect(res.headers.get('location') as string),
    )
    expect(payload.email).toBe('primary@example.com')
    expect(payload.name).toBe('Octo')
  })

  it('falls back to the login when the GitHub profile has no name', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(okResponse({ id: 42, login: 'octo', name: null }))
      .mockResolvedValueOnce(
        okResponse([
          { email: 'octo@example.com', primary: true, verified: true },
        ]),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('github')

    const res = await app.request(
      `/auth/oauth/github/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )

    const payload = decodeJwt(
      tokenFromRedirect(res.headers.get('location') as string),
    )
    expect(payload.name).toBe('octo')
  })
})

// ─── findOrCreateOAuthUser : branches de résolution du compte ─────────────────

describe('résolution du compte OAuth', () => {
  async function googleCallback() {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    const state = await signedState('google')
    return app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )
  }

  it('reuses the existing account without creating a user', async () => {
    // SELECT account → trouvé, puis SELECT user
    const sql = mockSql([
      [{ user_id: 'existing-user' }],
      [{ name: 'Stored Name', email: 'stored@example.com' }],
    ])

    const res = await googleCallback()

    const payload = decodeJwt(
      tokenFromRedirect(res.headers.get('location') as string),
    )
    expect(payload.sub).toBe('existing-user')
    // Les valeurs en base priment sur celles du provider
    expect(payload.name).toBe('Stored Name')
    expect(payload.email).toBe('stored@example.com')
    expect(sql).toHaveBeenCalledTimes(2) // aucun INSERT
  })

  it('links the OAuth account to an existing user matched by email', async () => {
    // SELECT account → vide, SELECT user par email → trouvé, INSERT account
    const sql = mockSql([[], [{ id: 'user-by-email', name: 'Alice' }], []])

    const res = await googleCallback()

    const payload = decodeJwt(
      tokenFromRedirect(res.headers.get('location') as string),
    )
    expect(payload.sub).toBe('user-by-email')
    expect(sql).toHaveBeenCalledTimes(3) // pas d'INSERT dans "user"
  })

  it('creates both the user and the account when nothing matches', async () => {
    const sql = mockSql(NEW_USER_DB)

    const res = await googleCallback()

    const payload = decodeJwt(
      tokenFromRedirect(res.headers.get('location') as string),
    )
    expect(payload.email).toBe('alice@example.com')
    expect(sql).toHaveBeenCalledTimes(4) // SELECT ×2 + INSERT ×2
  })

  it('queues a brand-new identity for approval instead of issuing a token', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    // SELECT account → none ; SELECT user by email → none ;
    // ensurePendingUserTable (unsafe) ; INSERT pending_user
    mockSql([[], [], undefined, undefined])
    const state = await signedState('google')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      { ...TEST_ENV, REGISTRATION_MODE: 'approval' },
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') as string)
    expect(location.pathname).toBe('/api/auth/callback')
    expect(location.searchParams.get('error')).toBe('pending_approval')
    expect(location.searchParams.get('token')).toBeNull()
  })

  it('still links a verified-email match to an existing account in approval mode', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    // SELECT account → none ; SELECT user by email → found ; INSERT account
    mockSql([[], [{ id: 'user-by-email', name: 'Alice' }], []])
    const state = await signedState('google')

    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      { ...TEST_ENV, REGISTRATION_MODE: 'approval' },
    )

    const payload = decodeJwt(
      tokenFromRedirect(res.headers.get('location') as string),
    )
    expect(payload.sub).toBe('user-by-email')
  })
})

// Le redirect_uri est choisi par l'appelant avant la signature du state : seule une
// liste blanche empêche de faire livrer le token de la victime chez un tiers.
describe('redirect_uri mobile — liste blanche', () => {
  async function callbackLocation(redirectUri: string): Promise<string> {
    fetchMock
      .mockResolvedValueOnce(okResponse({ access_token: 'at' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'g-1', email: 'alice@example.com', name: 'Alice' }),
      )
    mockSql(NEW_USER_DB)
    const state = await signedState('google', redirectUri)
    const res = await app.request(
      `/auth/oauth/google/callback?code=abc&state=${state}`,
      {},
      TEST_ENV,
    )
    return res.headers.get('location') as string
  }

  it('rejects an exp:// URI pointing at a public host', async () => {
    const location = await callbackLocation(
      'exp://evil.example.com/--/auth/callback',
    )
    expect(location.startsWith(TEST_ENV.UI_URL)).toBe(true)
  })

  it('rejects an exp:// URI on a private host but another path', async () => {
    const location = await callbackLocation('exp://192.168.1.20:8081/--/steal')
    expect(location.startsWith(TEST_ENV.UI_URL)).toBe(true)
  })

  it('rejects a stayup:// URI that is not the app callback', async () => {
    const location = await callbackLocation('stayup://evil')
    expect(location.startsWith(TEST_ENV.UI_URL)).toBe(true)
  })

  it('accepts the Expo Go URI on a private host', async () => {
    const location = await callbackLocation(
      'exp://192.168.1.20:8081/--/auth/callback',
    )
    expect(
      location.startsWith('exp://192.168.1.20:8081/--/auth/callback?token='),
    ).toBe(true)
  })
})
