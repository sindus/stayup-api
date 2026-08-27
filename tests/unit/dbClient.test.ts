import { afterEach, describe, expect, it } from 'vitest'
import { closeSql, getSql, trackOpenConnections } from '../../src/db/client.js'

const CONNECTION_STRING = 'postgres://user:pass@localhost:5432/db'

// closeSql() ne ferme que les connexions suivies : le suivi est opt-in.
trackOpenConnections(true)

afterEach(async () => {
  await closeSql()
})

describe('getSql', () => {
  it('returns a new connection on every call instead of caching across calls', () => {
    // Regression test: Cloudflare Workers throws "Cannot perform I/O on
    // behalf of a different request" if a connection opened by a previous
    // request is reused by a later one. getSql() must never cache.
    const a = getSql(CONNECTION_STRING)
    const b = getSql(CONNECTION_STRING)
    expect(a).not.toBe(b)
  })

  it('returns a tagged-template callable client', () => {
    const sql = getSql(CONNECTION_STRING)
    expect(typeof sql).toBe('function')
    expect(typeof sql.unsafe).toBe('function')
  })
})

describe('closeSql', () => {
  it('closes every connection returned by getSql without throwing', async () => {
    getSql(CONNECTION_STRING)
    getSql(CONNECTION_STRING)
    await expect(closeSql()).resolves.toBeUndefined()
  })

  it('is a no-op when nothing is open', async () => {
    await expect(closeSql()).resolves.toBeUndefined()
  })
})

// Le choix du moteur se fait sur le schéma de l'URL : c'est le point d'entrée du
// support multi-base, et une URL non reconnue doit se voir refuser tout de suite
// plutôt que d'échouer à la première requête.
describe('getStore', () => {
  it('accepts the postgres schemes', async () => {
    const { getStore } = await import('../../src/db/store.js')
    for (const url of [
      CONNECTION_STRING,
      CONNECTION_STRING.replace('postgres:', 'postgresql:'),
    ]) {
      expect(getStore(url)).toBeTruthy()
    }
  })

  it('names the supported schemes when the engine is unknown', async () => {
    const { getStore, SUPPORTED_SCHEMES } = await import(
      '../../src/db/store.js'
    )
    for (const url of [
      'mysql://x/y',
      'mongodb://x/y',
      'sqlite:///tmp/db',
      'nonsense',
    ]) {
      expect(() => getStore(url)).toThrow(/non prise en charge/)
    }
    expect(SUPPORTED_SCHEMES).toContain('postgres:')
  })
})
