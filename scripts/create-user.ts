import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import { getPool } from '../src/db/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const [, , username, password, role = 'user'] = process.argv

if (!username || !password) {
  console.error('Usage: tsx scripts/create-user.ts <username> <password> [role]')
  console.error('Roles: user (default), admin')
  process.exit(1)
}

if (!['user', 'admin'].includes(role)) {
  console.error('Role must be "user" or "admin"')
  process.exit(1)
}

const connectionString =
  process.env.DATABASE_URL ??
  `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup'}`

const pool = getPool(connectionString)

const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8')
await pool.query(schema)

const passwordHash = await bcrypt.hash(password, 10)

try {
  await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', [
    username,
    passwordHash,
    role,
  ])
  console.log(`User "${username}" created with role "${role}"`)
} catch (err: unknown) {
  if ((err as { code?: string }).code === '23505') {
    console.error(`User "${username}" already exists`)
    process.exit(1)
  }
  throw err
} finally {
  await pool.end()
}
