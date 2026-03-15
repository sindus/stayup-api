import { apiReference } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { openApiSpec } from './openapi.js'
import { authRoute } from './routes/auth.js'
import { connectorsRoute } from './routes/connectors.js'
import { feedRoute } from './routes/feed.js'
import { userProvidersRoute } from './routes/userProviders.js'
import { usersRoute } from './routes/users.js'
import type { Bindings } from './types.js'

const app = new Hono<{ Bindings: Bindings }>()

app.route('/auth', authRoute)
app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/connectors', connectorsRoute)
app.route('/users', usersRoute)
app.route('/feed', feedRoute)
app.route('/user', userProvidersRoute)

app.get('/openapi.json', (c) => c.json(openApiSpec))
app.get(
  '/docs',
  apiReference({
    spec: { url: '/openapi.json' },
    pageTitle: 'StayUp API',
  }),
)

export default app
