import { Hono } from 'hono'
import type postgres from 'postgres'
import { getSql } from '../db/client.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const connectorsRoute = new Hono<{ Bindings: Bindings }>()

connectorsRoute.use('*', authMiddleware)
connectorsRoute.use('/latest', requireAdmin)

async function getConnectorTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE ${'connector_%'}
    ORDER BY table_name
  `
  return rows.map((r) => r.table_name)
}

async function getTableColumns(
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

async function queryLatestPerProvider(
  sql: postgres.Sql,
  table: string,
): Promise<unknown[]> {
  const cols = await getTableColumns(sql, table)
  // connector_rss / connector_scrap use repository_id; others use provider_id
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

connectorsRoute.get('/', async (c) => {
  const sql = getSql(c.env.DATABASE_URL)
  const tables = await getConnectorTables(sql)
  const data: Record<string, unknown[]> = {}
  for (const table of tables) {
    const rows = await sql.unsafe(`SELECT * FROM "${table}" ORDER BY id`)
    data[table.replace(/^connector_/, '')] = rows
  }
  return c.json({ connectors: data })
})

connectorsRoute.get('/latest', async (c) => {
  const sql = getSql(c.env.DATABASE_URL)
  const tables = await getConnectorTables(sql)
  const data: Record<string, unknown[]> = {}
  for (const table of tables) {
    data[table.replace(/^connector_/, '')] = await queryLatestPerProvider(
      sql,
      table,
    )
  }
  return c.json({ latest: data })
})

connectorsRoute.get('/:name', async (c) => {
  const name = c.req.param('name')
  const sql = getSql(c.env.DATABASE_URL)
  const tableName = `connector_${name}`

  const [exists] = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
  `

  if (!exists) {
    return c.json({ error: `Connector '${name}' not found` }, 404)
  }

  const data = await queryLatestPerProvider(sql, tableName)
  return c.json({ connector: name, data })
})
