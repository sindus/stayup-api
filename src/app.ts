import { Hono } from 'hono'
import { connectorsRoute } from './routes/connectors.js'

const app = new Hono()

app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/connectors', connectorsRoute)

export default app
