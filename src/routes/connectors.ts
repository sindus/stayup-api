import { Hono } from 'hono'
import type { PoolClient } from 'pg'
import { pool } from '../db/client.js'

export const connectorsRoute = new Hono()

async function getConnectorTables(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'connector_%'
    ORDER BY table_name
  `)
  return result.rows.map((r) => r.table_name)
}

async function queryLatestPerProvider(client: PoolClient, table: string): Promise<unknown[]> {
  const result = await client.query(`
    SELECT DISTINCT ON (provider_id) *
    FROM "${table}"
    ORDER BY provider_id, COALESCE(datetime, executed_at) DESC
  `)
  return result.rows
}

connectorsRoute.get('/', async (c) => {
  const client = await pool.connect()
  try {
    const tables = await getConnectorTables(client)
    const data: Record<string, unknown[]> = {}
    for (const table of tables) {
      const result = await client.query(`SELECT * FROM "${table}" ORDER BY id`)
      data[table.replace(/^connector_/, '')] = result.rows
    }
    return c.json({ connectors: data })
  } finally {
    client.release()
  }
})

connectorsRoute.get('/latest', async (c) => {
  const client = await pool.connect()
  try {
    const tables = await getConnectorTables(client)
    const data: Record<string, unknown[]> = {}
    for (const table of tables) {
      data[table.replace(/^connector_/, '')] = await queryLatestPerProvider(client, table)
    }
    return c.json({ latest: data })
  } finally {
    client.release()
  }
})

connectorsRoute.get('/:name', async (c) => {
  const name = c.req.param('name')
  const client = await pool.connect()
  try {
    const tableName = `connector_${name}`
    const tableCheck = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1`,
      [tableName],
    )

    if (tableCheck.rows.length === 0) {
      return c.json({ error: `Connector '${name}' not found` }, 404)
    }

    const data = await queryLatestPerProvider(client, tableName)
    return c.json({ connector: name, data })
  } finally {
    client.release()
  }
})
