// Découverte dynamique des providers : l'API ne connaît aucun nom de provider en dur.
// Un provider existe dès qu'une table `connector_<name>` est présente en base ; son nom
// affiché vient de `provider_registry`, alimentée par le collecteur correspondant
// (projet indépendant type stayup-cmd-*) à chaque démarrage.
import type postgres from 'postgres'

const CONNECTOR_PREFIX = 'connector_'

export type Provider = {
  name: string
  displayName: string
  table: string
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export async function getConnectorTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE ${`${CONNECTOR_PREFIX}%`}
    ORDER BY table_name
  `
  return rows.map((r) => r.table_name)
}

export async function getTableColumns(
  sql: postgres.Sql,
  table: string,
): Promise<Set<string>> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `
  return new Set(rows.map((r) => r.column_name))
}

export async function queryLatestPerProvider(
  sql: postgres.Sql,
  table: string,
): Promise<unknown[]> {
  const cols = await getTableColumns(sql, table)
  const fkCol = cols.has('provider_id') ? 'provider_id' : 'repository_id'
  // connector_scrap has no datetime column
  const orderExpr = cols.has('datetime')
    ? 'COALESCE(datetime, executed_at)'
    : 'executed_at'

  return sql.unsafe(`
    SELECT DISTINCT ON ("${fkCol}") *
    FROM "${table}"
    ORDER BY "${fkCol}", ${orderExpr} DESC
  `)
}

// Liste des providers réellement disponibles (table connector_* présente), enrichis du
// nom affiché déclaré dans provider_registry. Un provider sans ligne de registre (pas
// encore démarré, ou registre pas à jour) retombe sur son nom capitalisé.
export async function getProviders(sql: postgres.Sql): Promise<Provider[]> {
  const tables = await getConnectorTables(sql)
  if (tables.length === 0) return []

  const names = tables.map((t) => t.slice(CONNECTOR_PREFIX.length))
  // `provider_registry` n'appartient pas à l'API : c'est le premier collecteur démarré
  // qui la crée. Sur une base où aucun collecteur à jour n'a encore tourné, la table
  // est absente — ce n'est pas une erreur, juste un registre vide : chaque provider
  // retombe sur son nom capitalisé, comme pour une ligne manquante.
  const registry = await sql<
    { name: string; display_name: string; sort_order: number }[]
  >`
    SELECT name, display_name, sort_order
    FROM provider_registry
    WHERE name = ANY(${names})
  `.catch(() => [])
  const meta = new Map(registry.map((r) => [r.name, r]))

  return names
    .map((name, i) => ({
      name,
      displayName: meta.get(name)?.display_name ?? capitalize(name),
      table: tables[i],
      sortOrder: meta.get(name)?.sort_order ?? 999,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ name, displayName, table }) => ({ name, displayName, table }))
}

// Résout la table connector_<name> pour un provider donné, seulement si elle existe
// réellement — remplace l'ancienne map statique `connectorTable`.
export async function getTableForProvider(
  sql: postgres.Sql,
  name: string,
): Promise<string | null> {
  const table = `${CONNECTOR_PREFIX}${name}`
  const [exists] = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `
  return exists ? table : null
}
