import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../../src/db/secretbox.js'

const URL = 'postgres://user:s3cret@db.example.com:5432/stayup'

describe('secretbox', () => {
  it('round-trips a connection string', async () => {
    const blob = await encryptSecret(URL, 'jwt-secret')
    expect(blob.startsWith('enc:v1:')).toBe(true)
    expect(blob).not.toContain('s3cret')
    expect(await decryptSecret(blob, 'jwt-secret')).toBe(URL)
  })

  it('produces a different blob each time (random IV)', async () => {
    const a = await encryptSecret(URL, 'k')
    const b = await encryptSecret(URL, 'k')
    expect(a).not.toBe(b)
    expect(await decryptSecret(a, 'k')).toBe(await decryptSecret(b, 'k'))
  })

  it('leaves a value without the prefix untouched', async () => {
    expect(await decryptSecret('sqlite:///data/app.db', 'k')).toBe(
      'sqlite:///data/app.db',
    )
  })

  it('fails to decrypt with the wrong key', async () => {
    const blob = await encryptSecret(URL, 'right')
    await expect(decryptSecret(blob, 'wrong')).rejects.toThrow()
  })
})
