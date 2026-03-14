import { Hono } from 'hono'
import { pool } from '../db/client.js'

export const connectorsRoute = new Hono()

connectorsRoute.get('/', async (c) => {
  const client = await pool.connect()
  try {
    const tablesResult = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'connector_%'
      ORDER BY table_name
    `)

    const connectorTables = tablesResult.rows.map((r) => r.table_name)
    const data: Record<string, unknown[]> = {}

    for (const table of connectorTables) {
      const result = await client.query(`SELECT * FROM "${table}" ORDER BY id`)
      data[table] = result.rows
    }

    return c.json({ connectors: data })
  } finally {
    client.release()
  }
})

connectorsRoute.get('/:name', async (c) => {
  const name = c.req.param('name')
  const client = await pool.connect()
  try {
    const tableCheck = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
         AND table_name LIKE 'connector_%'`,
      [name],
    )

    if (tableCheck.rows.length === 0) {
      return c.json({ error: `Connector '${name}' not found` }, 404)
    }

    const result = await client.query(`SELECT * FROM "${name}" ORDER BY id`)
    return c.json({ connector: name, data: result.rows })
  } finally {
    client.release()
  }
})
