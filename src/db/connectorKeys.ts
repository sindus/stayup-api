/**
 * Generation and verification of connector API keys.
 *
 * A key is a high-entropy secret generated server-side — not a human password —
 * so no `bcryptjs` here (see `admins.ts`/`auth.ts`): a plain fast, indexable
 * hash is enough, and allows a direct `WHERE key_hash = ?` rather than
 * comparing the key against every existing key.
 */

const KEY_PREFIX = 'stayup_conn_'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh plaintext key, in the form `stayup_conn_<48 hex characters>`. */
export function generateConnectorKey(): string {
  return KEY_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(24)))
}

/** SHA-256 of the key, which is what gets stored and compared — never the key itself. */
export async function hashConnectorKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  )
  return toHex(new Uint8Array(digest))
}

/** The first 8 characters after the prefix, to identify a key in the admin UI
 *  without ever showing the full secret again. */
export function connectorKeyPrefix(key: string): string {
  return key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8)
}
