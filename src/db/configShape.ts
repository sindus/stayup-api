/**
 * `repository.config` a porté, sur des bases Postgres existantes, un bug de
 * double sérialisation (voir `repairConfig` dans postgres.ts) : une config
 * autrefois stockée comme chaîne JSON, puis fusionnée avec l'opérateur `||`
 * contre un objet, ne produit pas un objet fusionné — `||` ne fusionne par
 * clé que deux objets ; face à un scalaire (une chaîne) et un objet, il
 * enveloppe le scalaire dans un tableau à un élément et concatène. Le
 * résultat observé en production : `["{\"max_scraps\":5}", {"title": "…"}]`
 * au lieu de `{"max_scraps": 5, "title": "…"}`.
 *
 * Cette fonction reconstruit un objet plat à partir de n'importe laquelle de
 * ces formes dégradées (objet, tableau, chaîne JSON, ou vide), sans perdre
 * les clés qu'elles portent encore — utilisée par `mergeSourceConfig` sur les
 * 4 adaptateurs pour fusionner sans jamais composer la corruption, et la
 * réparer au passage la prochaine fois qu'un connector touche la ligne.
 */
export function normalizeConfigObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {}
  if (Array.isArray(raw)) {
    const merged: Record<string, unknown> = {}
    for (const item of raw) Object.assign(merged, normalizeConfigObject(item))
    return merged
  }
  if (typeof raw === 'string') {
    try {
      return normalizeConfigObject(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}
