import postgres from 'postgres'

const instances = new Map<string, postgres.Sql>()

export function getSql(connectionString: string): postgres.Sql {
  let sql = instances.get(connectionString)
  if (!sql) {
    sql = postgres(connectionString, {
      max: 5,
      ssl: connectionString.includes('sslmode')
        ? { rejectUnauthorized: false }
        : false,
    })
    instances.set(connectionString, sql)
  }
  return sql
}
