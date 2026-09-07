import { serve } from '@hono/node-server'
import app from './app.js'
import { trackOpenConnections } from './db/client.js'

// Long-running process: we track connections so we can close them on shutdown.
// On Cloudflare Workers (src/app.ts), tracking stays disabled — see db/client.ts.
trackOpenConnections(true)

const {
  DB_HOST = 'localhost',
  DB_PORT = '5432',
  DB_NAME = 'stayup',
  DB_USER = 'postgres',
  DB_PASSWORD = 'postgres',
  JWT_SECRET = 'changeme',
  PORT = '3000',
  DATABASE_URL,
  UI_URL = 'http://localhost:3001',
  GOOGLE_CLIENT_ID = '',
  GOOGLE_CLIENT_SECRET = '',
  GITHUB_CLIENT_ID = '',
  GITHUB_CLIENT_SECRET = '',
  REGISTRATION_MODE = 'open',
  INSTANCE_NAME = '',
} = process.env

const databaseUrl =
  DATABASE_URL ??
  `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`

serve(
  {
    fetch: (req) =>
      app.fetch(req, {
        DATABASE_URL: databaseUrl,
        JWT_SECRET,
        UI_URL,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET,
        REGISTRATION_MODE,
        INSTANCE_NAME,
      }),
    port: Number(PORT),
  },
  (info) => console.log(`Server running on http://localhost:${info.port}`),
)
