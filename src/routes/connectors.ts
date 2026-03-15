import { Hono } from 'hono'
import type postgres from 'postgres'
import type { Bindings } from '../types.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js'
import { getSql } from '../db/client.js'

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

async function queryLatestPerProvider(sql: postgres.Sql, table: string): Promise<unknown[]> {
  return sql.unsafe(`
    SELECT DISTINCT ON (provider_id) *
    FROM "${table}"
    ORDER BY provider_id, COALESCE(datetime, executed_at) DESC
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
    data[table.replace(/^connector_/, '')] = await queryLatestPerProvider(sql, table)
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
