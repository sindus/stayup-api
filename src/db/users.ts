/** E-mails are stored and compared in lowercase: without this, signing up with
 *  `A@b.com` then logging in with `a@b.com` fails. The uniqueness constraint is
 *  case-sensitive on most engines; normalization is not. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
