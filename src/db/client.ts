import postgres from 'postgres'

export function getSql(connectionString: string): postgres.Sql {
  return postgres(connectionString, {
    max: 1,
    ssl: connectionString.includes('sslmode')
      ? { rejectUnauthorized: false }
      : false,
  })
}
