/** Les e-mails sont stockés et comparés en minuscules : sans ça, s'inscrire avec
 *  `A@b.com` puis se connecter avec `a@b.com` échoue. La contrainte d'unicité est
 *  sensible à la casse sur la plupart des moteurs, la normalisation ne l'est pas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
