import postgres from 'postgres'

// Un pool par chaîne de connexion, réutilisé entre les requêtes HTTP.
// Sans ce cache, chaque requête ouvrait une connexion jamais refermée.
const pools = new Map<string, postgres.Sql>()

export function getSql(connectionString: string): postgres.Sql {
  const cached = pools.get(connectionString)
  if (cached) return cached

  const sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    ssl: connectionString.includes('sslmode')
      ? { rejectUnauthorized: false }
      : false,
  })

  pools.set(connectionString, sql)
  return sql
}

// Ferme les pools ouverts (tests, arrêt propre du serveur).
export async function closeSql(): Promise<void> {
  const open = [...pools.values()]
  pools.clear()
  await Promise.all(open.map((sql) => sql.end()))
}
