import postgres from 'postgres'

// Cloudflare Workers interdit de réutiliser un objet d'I/O (ex: un socket
// TCP) ouvert par une requête différente de la requête en cours :
//
//   Error: Cannot perform I/O on behalf of a different request. I/O objects
//   (such as streams, request/response bodies, and others) created in the
//   context of one request handler cannot be accessed from a different
//   request's handler.
//
// L'ancien code mettait la connexion en cache dans une Map au niveau module,
// réutilisée entre requêtes HTTP sur un isolate Workers réchauffé — ce qui
// marche sur un serveur Node classique, mais viole cette règle sur Workers
// et fait planter (500) toute requête qui atterrit sur un isolate ayant déjà
// servi une requête précédente. On crée donc une connexion par appel.
const open = new Set<postgres.Sql>()

export function getSql(connectionString: string): postgres.Sql {
  const sql = postgres(connectionString, {
    max: 5,
    idle_timeout: 5,
    ssl: connectionString.includes('sslmode')
      ? { rejectUnauthorized: false }
      : false,
  })
  open.add(sql)
  return sql
}

// Ferme toutes les connexions ouvertes (tests, arrêt propre du serveur).
export async function closeSql(): Promise<void> {
  const toClose = [...open]
  open.clear()
  await Promise.all(toClose.map((sql) => sql.end()))
}
