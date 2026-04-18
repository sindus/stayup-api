import { apiReference } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { openApiSpec } from './openapi.js'
import { authRoute } from './routes/auth.js'
import { connectorsRoute } from './routes/connectors.js'
import { oauthRoute } from './routes/oauth.js'
import { uiUsersRoute } from './routes/uiUsers.js'
import type { Bindings } from './types.js'

const app = new Hono<{ Bindings: Bindings }>()

app.route('/auth', authRoute)
app.route('/auth', oauthRoute)
app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/connectors', connectorsRoute)
app.route('/ui/users', uiUsersRoute)

app.get('/openapi.json', (c) => c.json(openApiSpec))
app.get(
  '/docs',
  apiReference({
    url: '/openapi.json',
    pageTitle: 'StayUp API',
  }),
)

export default app
