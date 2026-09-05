import { describe, expect, it } from 'vitest'
import { normalizeConfigObject } from '../../src/db/configShape.js'

describe('normalizeConfigObject', () => {
  it('returns a plain object unchanged', () => {
    expect(normalizeConfigObject({ max_entries: 5 })).toEqual({
      max_entries: 5,
    })
  })

  it('returns an empty object for null/undefined', () => {
    expect(normalizeConfigObject(null)).toEqual({})
    expect(normalizeConfigObject(undefined)).toEqual({})
  })

  it('returns an empty object for a scalar', () => {
    expect(normalizeConfigObject(42)).toEqual({})
    expect(normalizeConfigObject(true)).toEqual({})
  })

  it('parses a JSON-encoded string into an object', () => {
    expect(normalizeConfigObject('{"max_entries":5}')).toEqual({
      max_entries: 5,
    })
  })

  it('returns an empty object for an unparsable string', () => {
    expect(normalizeConfigObject('not json')).toEqual({})
  })

  it('reconstructs an object from the observed production corruption', () => {
    // config || jsonb_build_object(...) sur un config déjà double-sérialisé
    // (chaîne) produit un tableau [ancienneChaîne, nouvelObjet] — voir
    // db/configShape.ts. On doit retrouver les deux jeux de clés.
    const corrupted = ['{"max_scraps":5,"retention_days":15}', { title: 'X' }]
    expect(normalizeConfigObject(corrupted)).toEqual({
      max_scraps: 5,
      retention_days: 15,
      title: 'X',
    })
  })

  it('merges array elements left to right, later keys winning', () => {
    expect(normalizeConfigObject([{ a: 1 }, { a: 2, b: 3 }])).toEqual({
      a: 2,
      b: 3,
    })
  })

  it('drops unparsable or scalar elements inside an array', () => {
    expect(normalizeConfigObject(['not json', 42, { a: 1 }])).toEqual({
      a: 1,
    })
  })
})
