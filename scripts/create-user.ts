import bcrypt from 'bcryptjs'
import { pool } from '../src/db/client.js'

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
