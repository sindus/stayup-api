import { serve } from '@hono/node-server'
import app from './app.js'

const {
  DB_HOST = 'localhost',
  DB_PORT = '5432',
  DB_NAME = 'stayup',
  DB_USER = 'postgres',
  DB_PASSWORD = 'postgres',
  JWT_SECRET = 'changeme',
  PORT = '3000',
  DATABASE_URL,
} = process.env

const databaseUrl =
  DATABASE_URL ?? `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`

serve(
  {
    fetch: (req) => app.fetch(req, { DATABASE_URL: databaseUrl, JWT_SECRET }),
    port: Number(PORT),
  },
  (info) => console.log(`Server running on http://localhost:${info.port}`),
)
