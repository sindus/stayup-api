import { hash } from 'bcryptjs'
import type postgres from 'postgres'

/** Les e-mails sont stockés et comparés en minuscules : sans ça, s'inscrire avec
 *  `A@b.com` puis se connecter avec `a@b.com` échoue (la colonne est UNIQUE mais
 *  sensible à la casse). Voir aussi la recherche de compte dans routes/auth.ts. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

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
  const email = normalizeEmail(user.email)

  try {
    // Les deux INSERT doivent réussir ou échouer ensemble : sinon un échec sur
    // `account` laisse un utilisateur orphelin, incapable de se connecter et dont
    // l'e-mail reste pris définitivement.
    await sql.begin(async (transaction) => {
      // `TransactionSql` est déclaré en Omit<Sql, …>, ce qui lui fait perdre la
      // signature d'appel du tag SQL : on le retype pour pouvoir l'utiliser.
      const tx = transaction as unknown as postgres.Sql
      await tx`
        INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
        VALUES (${userId}, ${user.name}, ${email}, ${now}, ${now}, false)
      `
      await tx`
        INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
        VALUES (
          ${accountId},
          ${userId},
          'credential',
          ${email},
          ${passwordHash},
          ${now},
          ${now}
        )
      `
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null
    throw err
  }

  return { id: userId }
}
