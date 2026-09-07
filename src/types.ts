export type Bindings = {
  DATABASE_URL: string
  JWT_SECRET: string
  UI_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  /** 'open' (default): signing up activates the account right away.
   *  'approval': the account stays pending until an admin approves it. */
  REGISTRATION_MODE: string
  /** Human-readable instance name, exposed by GET /auth/config. Apps use it as
   *  the default label for an instance they add. Optional: absent on Workers if
   *  the secret is not set. */
  INSTANCE_NAME?: string
  /** Shared secret that authorizes `POST /ui/maintenance/cleanup` without an
   *  admin JWT — this is what the cleanup cron (GitHub Actions) sends as
   *  `Authorization: Bearer`. Absent → only an admin can trigger the purge. */
  CLEANUP_SECRET?: string
}

/** Effective registration mode: anything that is not 'approval' means 'open'. */
export function registrationMode(env: Bindings): 'open' | 'approval' {
  return env.REGISTRATION_MODE === 'approval' ? 'approval' : 'open'
}
