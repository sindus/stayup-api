import { hash } from 'bcryptjs'
import type postgres from 'postgres'

// Crée un utilisateur et son compte 'credential'.
// Renvoie null si l'email est déjà pris (contrainte unique 23505).
export async function createCredentialUser(
  sql: postgres.Sql,
  user: { name: string; email: string; password: string },
): Promise<{ id: string } | null> {
  const passwordHash = await hash(user.password, 10)
  const userId = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    await sql`
      INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
      VALUES (${userId}, ${user.name}, ${user.email}, ${now}, ${now}, false)
    `
    await sql`
      INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
      VALUES (
        ${accountId},
        ${userId},
        'credential',
        ${user.email},
        ${passwordHash},
        ${now},
        ${now}
      )
    `
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null
    throw err
  }

  return { id: userId }
}
