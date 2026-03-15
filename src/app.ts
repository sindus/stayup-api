import { Hono } from 'hono'
import type { Bindings } from './types.js'
import { authRoute } from './routes/auth.js'
import { connectorsRoute } from './routes/connectors.js'

const app = new Hono<{ Bindings: Bindings }>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message, stack: err.stack }, 500)
})

app.route('/auth', authRoute)
app.get('/', (c) => c.json({ status: 'ok' }))
app.get('/debug-env', (c) => c.json({ keys: Object.keys(c.env ?? {}), db: !!c.env?.DATABASE_URL, jwt: !!c.env?.JWT_SECRET }))
app.route('/connectors', connectorsRoute)

export default app
