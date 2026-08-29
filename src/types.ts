export type Bindings = {
  DATABASE_URL: string
  JWT_SECRET: string
  UI_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  /** 'open' (défaut) : l'inscription active le compte tout de suite.
   *  'approval' : le compte reste en attente jusqu'à validation d'un admin. */
  REGISTRATION_MODE: string
}

/** Mode d'inscription effectif : tout ce qui n'est pas 'approval' vaut 'open'. */
export function registrationMode(env: Bindings): 'open' | 'approval' {
  return env.REGISTRATION_MODE === 'approval' ? 'approval' : 'open'
}
