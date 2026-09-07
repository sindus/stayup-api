import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash } from 'bcryptjs'
import { closeSql, getSql, trackOpenConnections } from '../src/db/client.js'
import { PostgresStore } from '../src/db/postgres.js'
import { normalizeEmail } from '../src/db/users.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Args take precedence; env vars are the fallback so a caller can avoid putting
// the password on the command line (e.g. `docker compose run -e ADMIN_PASSWORD`).
const [, , argEmail, argName, argPassword] = process.argv
const email = argEmail ?? process.env.ADMIN_EMAIL
const name = argName ?? process.env.ADMIN_NAME
const password = argPassword ?? process.env.ADMIN_PASSWORD

if (!email || !name || !password) {
  console.error('Usage: create-admin <email> <name> <password>')
  console.error(
    '  (or set ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD in the environment)',
  )
  console.error(
    '  npm run create-admin  <email> <name> <password>   (from source)',
  )
  console.error(
    '  node dist/scripts/create-admin.js  <email> <name> <password>   (built image)',
  )
  console.error(
    'Creates a SUPER admin (can manage other admins). Regular admins are',
  )
  console.error('created from the UI once a super admin exists.')
  process.exit(1)
}

const connectionString =
  process.env.DATABASE_URL ??
  `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup'}`

// This script applies the SQL schema: it is PostgreSQL-specific, unlike the API
// itself. The other engines have their own way of bootstrapping.
trackOpenConnections(true)
const sql = getSql(connectionString)

try {
  const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8')
  await sql.unsafe(schema)

  const created = await new PostgresStore(sql).createAdmin({
    email: normalizeEmail(email),
    name,
    passwordHash: await hash(password, 10),
    isSuper: true,
  })

  if (!created) {
    console.error(`Email "${email}" is already in use`)
    process.exit(1)
  }

  console.log(`Super admin "${name}" <${email}> created with id ${created.id}`)
} finally {
  await closeSql()
}
