import { Hono } from 'hono'
import { authRoute } from './routes/auth.js'
import { connectorsRoute } from './routes/connectors.js'
import type { Bindings } from './types.js'

const app = new Hono<{ Bindings: Bindings }>()

app.route('/auth', authRoute)
app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/connectors', connectorsRoute)

export default app
