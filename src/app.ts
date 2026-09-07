import { apiReference } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { openApiSpec } from './openapi.js'
import { adminConnectorKeysRoute } from './routes/adminConnectorKeys.js'
import { adminProvidersRoute } from './routes/adminProviders.js'
import { adminRepositoriesRoute } from './routes/adminRepositories.js'
import { adminsRoute } from './routes/admins.js'
import { authRoute } from './routes/auth.js'
import { connectorApiRoute } from './routes/connectorApi.js'
import { connectorsRoute } from './routes/connectors.js'
import { dataSourcesRoute } from './routes/dataSources.js'
import { fluxRequestsAdminRoute } from './routes/fluxRequests.js'
import { maintenanceRoute } from './routes/maintenance.js'
import { oauthRoute } from './routes/oauth.js'
import { providerFluxesRoute } from './routes/providerFluxes.js'
import { uiUsersRoute } from './routes/uiUsers.js'
import type { Bindings } from './types.js'

const app = new Hono<{ Bindings: Bindings }>()

app.use(cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

app.route('/auth', authRoute)
app.route('/auth', oauthRoute)
app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/connectors', connectorsRoute)
app.route('/connector-api', connectorApiRoute)
app.route('/providers', providerFluxesRoute)
app.route('/ui/users', uiUsersRoute)
app.route('/ui/data-sources', dataSourcesRoute)
app.route('/ui/admins', adminsRoute)
app.route('/ui/providers', adminProvidersRoute)
app.route('/ui/repositories', adminRepositoriesRoute)
app.route('/ui/flux-requests', fluxRequestsAdminRoute)
app.route('/ui/connector-keys', adminConnectorKeysRoute)
app.route('/ui/maintenance', maintenanceRoute)

app.get('/openapi.json', (c) => c.json(openApiSpec))
app.get(
  '/docs',
  apiReference({
    url: '/openapi.json',
    pageTitle: 'StayUp API',
  }),
)

export default app
