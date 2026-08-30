/**
 * Chiffrement au repos des chaînes de connexion des bases secondaires.
 *
 * Une base secondaire (table `data_source`) porte son URL de connexion — un
 * secret. On la chiffre avec une clé dérivée de `JWT_SECRET` (déjà présent
 * partout, jamais commité), en AES-GCM via Web Crypto : ça tourne à l'identique
 * sous Node et sous Cloudflare Workers, contrairement à `node:crypto`.
 *
 * Format : `enc:v1:<base64(iv(12) ++ ciphertext+tag)>`. Une valeur sans ce
 * préfixe est renvoyée telle quelle — tolérance pour une base remplie à la main.
 */

const PREFIX = 'enc:v1:'

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function b64encode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function aesKey(secret: string) {
  return crypto.subtle
    .digest('SHA-256', toBytes(secret))
    .then((digest) =>
      crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]),
    )
}

export async function encryptSecret(
  plaintext: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await aesKey(secret)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      toBytes(plaintext),
    ),
  )
  const packed = new Uint8Array(iv.length + ct.length)
  packed.set(iv, 0)
  packed.set(ct, iv.length)
  return PREFIX + b64encode(packed)
}

export async function decryptSecret(
  blob: string,
  secret: string,
): Promise<string> {
  if (!blob.startsWith(PREFIX)) return blob
  const packed = b64decode(blob.slice(PREFIX.length))
  const iv = packed.slice(0, 12)
  const ct = packed.slice(12)
  const key = await aesKey(secret)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}
