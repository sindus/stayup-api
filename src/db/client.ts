import postgres from 'postgres'

// Cloudflare Workers forbids reusing an I/O object (e.g. a TCP socket) opened
// by a request other than the one currently running:
//
//   Error: Cannot perform I/O on behalf of a different request. I/O objects
//   (such as streams, request/response bodies, and others) created in the
//   context of one request handler cannot be accessed from a different
//   request's handler.
//
// The old code cached the connection in a module-level Map, reused across HTTP
// requests on a warm Workers isolate — which works on a plain Node server, but
// violates this rule on Workers and makes any request that lands on an isolate
// which already served a previous request crash (500). So we create one
// connection per call.
//
// Corollary: these connections cannot be held forever. The registry below only
// exists for `closeSql()` (tests, clean shutdown of a Node server) and is
// therefore disabled by default: enabling it in production would grow the Set
// on every request to a warm isolate, with nothing ever removing entries.
const open = new Set<postgres.Sql>()
let tracking = false

/** Enables tracking of open connections, required by `closeSql()`. Reserved for
 *  tests and long-running processes that want to shut down cleanly. */
export function trackOpenConnections(enabled: boolean): void {
  tracking = enabled
  if (!enabled) open.clear()
}

export function getSql(connectionString: string): postgres.Sql {
  const sql = postgres(connectionString, {
    max: 5,
    idle_timeout: 5,
    ssl: connectionString.includes('sslmode')
      ? { rejectUnauthorized: false }
      : false,
  })
  if (tracking) open.add(sql)
  return sql
}

// Closes every tracked connection (see trackOpenConnections).
export async function closeSql(): Promise<void> {
  const toClose = [...open]
  open.clear()
  await Promise.all(toClose.map((sql) => sql.end()))
}
