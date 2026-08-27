import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash } from 'bcryptjs'
import { closeSql, getSql, trackOpenConnections } from '../src/db/client.js'
import { PostgresStore } from '../src/db/postgres.js'
import { normalizeEmail } from '../src/db/users.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const [, , name, email, password] = process.argv

if (!name || !email || !password) {
  console.error('Usage: tsx scripts/create-user.ts <name> <email> <password>')
  console.error(
    'Note: admin access is not stored in the database — it uses the',
  )
  console.error('      API_USERNAME / API_PASSWORD service account instead.')
  process.exit(1)
}

const connectionString =
  process.env.DATABASE_URL ??
  `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup'}`

// Ce script applique le schéma SQL : il est propre à PostgreSQL, contrairement
// à l'API elle-même. Les autres moteurs ont leur propre façon d'amorcer.
trackOpenConnections(true)
const sql = getSql(connectionString)

try {
  const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8')
  await sql.unsafe(schema)

  const created = await new PostgresStore(sql).createCredentialUser({
    name,
    email: normalizeEmail(email),
    passwordHash: await hash(password, 10),
  })

  if (!created) {
    console.error(`Email "${email}" is already in use`)
    process.exit(1)
  }

  console.log(`User "${name}" <${email}> created with id ${created.id}`)
} finally {
  await closeSql()
}
