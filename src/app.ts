import { apiReference } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { openApiSpec } from './openapi.js'
import { adminRepositoriesRoute } from './routes/adminRepositories.js'
import { authRoute } from './routes/auth.js'
import { connectorsRoute } from './routes/connectors.js'
import { oauthRoute } from './routes/oauth.js'
import { scrapRoute } from './routes/scrap.js'
import {
  scrapRequestsAdminRoute,
  scrapRequestsUserRoute,
} from './routes/scrapRequests.js'
import { uiUsersRoute } from './routes/uiUsers.js'
import type { Bindings } from './types.js'

const app = new Hono<{ Bindings: Bindings }>()

app.use(cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

app.route('/auth', authRoute)
app.route('/auth', oauthRoute)
app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/connectors', connectorsRoute)
app.route('/ui/users', uiUsersRoute)
app.route('/ui/repositories', adminRepositoriesRoute)
app.route('/scrap/requests', scrapRequestsUserRoute)
app.route('/scrap', scrapRoute)
app.route('/ui/scrap-requests', scrapRequestsAdminRoute)

app.get('/openapi.json', (c) => c.json(openApiSpec))
app.get(
  '/docs',
  apiReference({
    url: '/openapi.json',
    pageTitle: 'StayUp API',
  }),
)

export default app
