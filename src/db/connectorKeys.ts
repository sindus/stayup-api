/**
 * Génération et vérification des clés d'API de connectors.
 *
 * Une clé est un secret à haute entropie généré côté serveur — pas un mot de
 * passe humain — donc pas de `bcryptjs` ici (voir `admins.ts`/`auth.ts`) : un
 * simple hash rapide et indexable suffit, et permet un `WHERE key_hash = ?`
 * direct plutôt que de comparer la clé à chacune des clés existantes.
 */

const KEY_PREFIX = 'stayup_conn_'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Une nouvelle clé en clair, au format `stayup_conn_<48 caractères hex>`. */
export function generateConnectorKey(): string {
  return KEY_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(24)))
}

/** SHA-256 de la clé, ce qui est stocké et comparé — jamais la clé elle-même. */
export async function hashConnectorKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  )
  return toHex(new Uint8Array(digest))
}

/** Les 8 premiers caractères après le préfixe, pour identifier une clé dans
 *  l'interface admin sans jamais réafficher le secret complet. */
export function connectorKeyPrefix(key: string): string {
  return key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8)
}
