import { Pool } from 'pg'

const pools = new Map<string, Pool>()

export function getPool(connectionString: string): Pool {
  let pool = pools.get(connectionString)
  if (!pool) {
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
    pools.set(connectionString, pool)
  }
  return pool
}
