import { Hono } from 'hono'
import { authMiddleware, requireAdmin } from './middleware/auth.js'
import { authRoute } from './routes/auth.js'
import { connectorsRoute } from './routes/connectors.js'

const app = new Hono()

app.route('/auth', authRoute)
app.get('/', (c) => c.json({ status: 'ok' }))

app.use('/connectors*', authMiddleware)
app.use('/connectors/latest', requireAdmin)

app.route('/connectors', connectorsRoute)

export default app
