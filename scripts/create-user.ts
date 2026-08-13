import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeSql, getSql } from '../src/db/client.js'
import { createCredentialUser } from '../src/db/users.js'

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

const sql = getSql(connectionString)

try {
  const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8')
  await sql.unsafe(schema)

  const created = await createCredentialUser(sql, { name, email, password })

  if (!created) {
    console.error(`Email "${email}" is already in use`)
    process.exit(1)
  }

  console.log(`User "${name}" <${email}> created with id ${created.id}`)
} finally {
  await closeSql()
}
