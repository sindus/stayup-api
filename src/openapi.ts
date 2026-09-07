export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'StayUp API',
    version: '2.1.0',
    description:
      'HTTP API exposing StayUp data — connectors, users and content feeds.',
  },
  servers: [
    {
      url: 'https://stayup-api.r-sik.workers.dev',
      description: 'Production (Cloudflare Workers)',
    },
    {
      url: 'http://localhost:3000',
      description: 'Local',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token obtained via POST /auth/login',
      },
    },
    schemas: {
      UserRepository: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          repository_id: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          url: { type: 'string' },
          provider: {
            type: 'string',
            description:
              'Provider name (dynamic — see GET /connectors/providers)',
          },
          config: { type: 'object' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Admin: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          is_super: {
            type: 'boolean',
            description: 'Can manage the other administrators.',
          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ProviderFlux: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          url: { type: 'string' },
          config: { type: 'object' },
          created_at: { type: 'string', format: 'date-time' },
          is_subscribed: {
            type: 'boolean',
            description: "The current user's subscription to this flux",
          },
        },
      },
      FluxRequest: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string' },
          user_email: { type: 'string', format: 'email' },
          provider: { type: 'string' },
          url: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected'],
          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/': {
      get: {
        summary: 'Health check',
        tags: ['General'],
        responses: {
          200: {
            description: 'API is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string', example: 'ok' } },
                },
              },
            },
          },
        },
      },
    },
    '/auth/config': {
      get: {
        summary: 'Public authentication configuration',
        description:
          'What a client needs to know before showing the login screen: ' +
          'the instance’s readable name (`INSTANCE_NAME`, `null` if unset), ' +
          'registration mode (`open` | `approval`) and available login methods.',
        tags: ['Authentication'],
        responses: {
          200: {
            description: 'Configuration',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', nullable: true },
                    registrationMode: {
                      type: 'string',
                      enum: ['open', 'approval'],
                    },
                    emailPassword: { type: 'boolean' },
                    oauth: {
                      type: 'object',
                      properties: {
                        google: { type: 'boolean' },
                        github: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/auth/register': {
      post: {
        summary: 'Create a user account',
        description:
          'Public sign-up. In `open` mode, creates the user and returns ' +
          'a JWT (201). In `approval` mode, puts the request on hold (202, no ' +
          'token) until an admin approves it.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                  name: { type: 'string', example: 'Alice' },
                  email: {
                    type: 'string',
                    format: 'email',
                    example: 'alice@example.com',
                  },
                  password: { type: 'string', example: 'mypassword' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Account created, JWT token returned',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { token: { type: 'string' } },
                },
              },
            },
          },
          202: {
            description: 'approval mode: request awaiting approval',
          },
          400: { description: 'Missing required fields' },
          409: { description: 'Email already in use' },
        },
      },
    },
    '/auth/oauth/google': {
      get: {
        summary: 'Start the Google OAuth flow',
        description:
          'Generates a JWT state and redirects to Google OAuth. `redirect_uri` ' +
          '(mobile deep link) and `client_state` (opaque value returned as-is ' +
          'in `&state=` on the callback) are optional.',
        tags: ['Authentication'],
        parameters: [
          { name: 'redirect_uri', in: 'query', schema: { type: 'string' } },
          { name: 'client_state', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          302: { description: 'Redirect to Google' },
        },
      },
    },
    '/auth/oauth/google/callback': {
      get: {
        summary: 'Google OAuth callback',
        description:
          'Exchanges the code, creates/finds the user, redirects to the UI with a JWT.',
        tags: ['Authentication'],
        parameters: [
          {
            name: 'code',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'state',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          302: {
            description: 'Redirect to the UI (/api/auth/callback?token=JWT)',
          },
          400: { description: 'Invalid state or missing code' },
        },
      },
    },
    '/auth/oauth/github': {
      get: {
        summary: 'Start the GitHub OAuth flow',
        description:
          'Generates a JWT state and redirects to GitHub OAuth. `redirect_uri` ' +
          'and `client_state` (returned as `&state=` on the callback) are optional.',
        tags: ['Authentication'],
        parameters: [
          { name: 'redirect_uri', in: 'query', schema: { type: 'string' } },
          { name: 'client_state', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          302: { description: 'Redirect to GitHub' },
        },
      },
    },
    '/auth/oauth/github/callback': {
      get: {
        summary: 'GitHub OAuth callback',
        description:
          'Exchanges the code, creates/finds the user, redirects to the UI with a JWT.',
        tags: ['Authentication'],
        parameters: [
          {
            name: 'code',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'state',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          302: {
            description: 'Redirect to the UI (/api/auth/callback?token=JWT)',
          },
          400: { description: 'Invalid state or missing code' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Log in — obtain a JWT token',
        description:
          'Admin authentication (username = admin account e-mail + password) ' +
          'or user (email + password). Admins are stored in the database ' +
          '(table `admin`); the first one is created via `npm run create-admin`.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    title: 'Admin',
                    type: 'object',
                    required: ['username', 'password'],
                    properties: {
                      username: {
                        type: 'string',
                        format: 'email',
                        example: 'root@example.com',
                      },
                      password: { type: 'string', example: 'Azerty123!' },
                    },
                  },
                  {
                    title: 'User',
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email: {
                        type: 'string',
                        format: 'email',
                        example: 'user@example.com',
                      },
                      password: { type: 'string', example: 'mypassword' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'JWT token',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { token: { type: 'string' } },
                },
              },
            },
          },
          400: { description: 'Missing required fields' },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Identity carried by the token',
        description:
          "Validates the token's signature and expiration, then returns its identity. " +
          'Intended for clients that do not know JWT_SECRET and can therefore ' +
          'only decode the payload without verifying it.',
        tags: ['Authentication'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "The token bearer's identity",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string' },
                    role: { type: 'string', enum: ['user', 'admin'] },
                    isSuper: {
                      type: 'boolean',
                      description:
                        'True for a super admin (manages the other admins).',
                    },
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                  },
                },
              },
            },
          },
          401: { description: 'Token missing, invalid or expired' },
        },
      },
    },
    '/connectors': {
      get: {
        summary: 'All data from all connectors',
        tags: ['Connectors'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Data from every connector_* table',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connectors: {
                      type: 'object',
                      description:
                        'One key per discovered provider (see GET /connectors/providers)',
                      additionalProperties: { type: 'array', items: {} },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
        },
      },
    },
    '/connectors/providers': {
      get: {
        summary: 'List of discovered providers',
        description:
          'Available providers (connector_<name> table present in the database), with their display name from provider_registry. Used to build a dynamic UI (tabs, flux-adding selector) without pulling all the data.',
        tags: ['Connectors'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'List of providers',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    providers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string', example: 'youtube' },
                          displayName: { type: 'string', example: 'YouTube' },
                          fluxApproval: {
                            type: 'string',
                            enum: ['auto', 'manual'],
                            description:
                              'Mode for a user adding a flux: `auto` (created right away) or `manual` (a request an admin must approve).',
                          },
                          template: {
                            type: 'object',
                            nullable: true,
                            description:
                              'Display manifest the provider declares for the apps (provider_registry.template). Relayed as-is, not interpreted by the API; absent if the provider does not publish one — apps then render generically.',
                            additionalProperties: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
        },
      },
    },
    '/connectors/latest': {
      get: {
        summary: 'Latest entry per source for each connector',
        tags: ['Connectors'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Latest content per repository_id',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    latest: {
                      type: 'object',
                      additionalProperties: { type: 'array', items: {} },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
        },
      },
    },
    '/connectors/{name}': {
      get: {
        summary: 'Latest entry per source for a specific connector',
        tags: ['Connectors'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description:
              'Connector name (without the connector_ prefix) — see GET /connectors/providers for the available list',
          },
        ],
        responses: {
          200: {
            description: 'Connector data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connector: { type: 'string' },
                    data: { type: 'array', items: {} },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          404: { description: 'Connector not found' },
        },
      },
    },
    '/ui/users': {
      get: {
        summary: 'List all users',
        tags: ['Admin — Users'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'List of users',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    users: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/User' },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
        },
      },
      post: {
        summary: 'Create a user',
        tags: ['Admin — Users'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                  name: { type: 'string', example: 'Alice' },
                  email: {
                    type: 'string',
                    format: 'email',
                    example: 'alice@example.com',
                  },
                  password: { type: 'string', example: 'mypassword' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'User created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          400: { description: 'Missing required fields' },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
          409: { description: 'Email already in use' },
        },
      },
    },
    '/ui/admins': {
      get: {
        summary: 'List administrators (super admin)',
        tags: ['Admin — Admins'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'List of admins',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    admins: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Admin' },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Super admin required' },
        },
      },
      post: {
        summary: 'Create a normal administrator (super admin)',
        description:
          'Creates a non-super admin. Super admins can only be created from the command line.',
        tags: ['Admin — Admins'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'name', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Admin created' },
          400: { description: 'Missing required fields' },
          403: { description: 'Super admin required' },
          409: { description: 'Email already in use' },
        },
      },
    },
    '/ui/admins/me': {
      patch: {
        summary: 'Change your own password (admin)',
        tags: ['Admin — Admins'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'password'],
                properties: {
                  currentPassword: { type: 'string' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Password changed' },
          400: { description: 'Missing required fields' },
          401: { description: 'Current password incorrect' },
        },
      },
    },
    '/ui/admins/{id}': {
      patch: {
        summary: 'Edit an administrator (super admin)',
        tags: ['Admin — Admins'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Admin edited' },
          403: { description: 'Super admin required' },
          404: { description: 'Admin not found' },
          409: { description: 'Email already in use' },
        },
      },
      delete: {
        summary: 'Delete an administrator (super admin)',
        description:
          'A super admin cannot be deleted from the UI, nor can you delete yourself.',
        tags: ['Admin — Admins'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: { description: 'Admin deleted' },
          403: {
            description: 'Super admin required, or target is a super admin',
          },
          404: { description: 'Admin not found' },
          409: { description: 'You cannot delete yourself' },
        },
      },
    },
    '/ui/data-sources': {
      get: {
        summary: 'Secondary databases',
        description:
          'The primary database (info) + the declared secondary databases. The ' +
          'connection string is never returned — only the host. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Primary database + secondary databases' },
          403: { description: 'Admin required' },
        },
      },
      post: {
        summary: 'Add a secondary database',
        description:
          'Tests the URL, refuses if no connector_* table exists there, then ' +
          'saves it encrypted. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'url'],
                properties: {
                  name: { type: 'string' },
                  url: {
                    type: 'string',
                    example: 'postgres://user:pass@host:5432/db',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Database added' },
          400: { description: 'Invalid URL, unreachable, or no connector' },
          403: { description: 'Admin required' },
        },
      },
    },
    '/ui/data-sources/test': {
      post: {
        summary: 'Test a database URL without saving it',
        description:
          'Returns `{ ok, engine, connectors }` or `{ ok: false, error }`. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: { url: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Test result' },
          403: { description: 'Admin required' },
        },
      },
    },
    '/ui/data-sources/{id}': {
      delete: {
        summary: 'Remove a secondary database',
        description:
          'Deletes the database and, cascading, the external subscriptions that ' +
          'targeted it. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          200: { description: 'Database removed' },
          404: { description: 'Database not found' },
        },
      },
    },
    '/ui/users/pending': {
      get: {
        summary: 'Sign-ups awaiting approval',
        description:
          'Accounts created in `approval` mode and not yet activated. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'List of pending sign-ups' },
          403: { description: 'Admin required' },
        },
      },
    },
    '/ui/users/pending/{id}/approve': {
      post: {
        summary: 'Approve a pending sign-up',
        description:
          'Creates the account from the request (e-mail or OAuth) and removes ' +
          'the pending row. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          201: { description: 'Account created' },
          404: { description: 'Request not found' },
          409: { description: 'Email taken in the meantime' },
        },
      },
    },
    '/ui/users/pending/{id}/reject': {
      post: {
        summary: 'Reject a pending sign-up',
        description: 'Deletes the request. Admin required.',
        tags: ['Administration'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: { description: 'Request rejected' },
          404: { description: 'Request not found' },
        },
      },
    },
    '/ui/users/{userId}': {
      get: {
        summary: "A user's profile",
        description: 'Accessible by the user themselves or an admin.',
        tags: ['UI — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: "The user's profile",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { user: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Access denied' },
          404: { description: 'User not found' },
        },
      },
      patch: {
        summary: 'Edit a user',
        description: 'Accessible by the user themselves or an admin.',
        tags: ['UI — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'User edited',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Access denied (self or admin required)' },
          404: { description: 'User not found' },
        },
      },
      delete: {
        summary: 'Delete a user',
        tags: ['Admin — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'User deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
          404: { description: 'User not found' },
        },
      },
    },
    '/ui/users/{userId}/feed': {
      get: {
        summary: "A user's full content feed",
        description:
          'Returns the configured fluxes and the associated content (all connectors). Accessible by the user themselves or an admin.',
        tags: ['UI — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "The user's ID",
          },
        ],
        responses: {
          200: {
            description: "The user's feed",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    repositories: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/UserRepository' },
                    },
                    connectors: {
                      type: 'object',
                      description:
                        'One key per discovered provider (see GET /connectors/providers)',
                      additionalProperties: { type: 'array', items: {} },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Access denied' },
        },
      },
    },
    '/ui/users/{userId}/feed/{connector}': {
      get: {
        summary: "A user's content feed for one connector",
        description:
          "Returns only the specified connector's content for the user. Accessible by the user themselves or an admin.",
        tags: ['UI — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'connector',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'See GET /connectors/providers for the available list',
          },
        ],
        responses: {
          200: {
            description: 'Connector content',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connector: { type: 'string' },
                    data: { type: 'array', items: {} },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Access denied' },
          404: { description: 'Unknown connector' },
        },
      },
    },
    '/ui/users/{userId}/repositories': {
      post: {
        summary: 'Add a flux to a user',
        description:
          "If the provider is in `manual` mode and the caller is a user (not an admin) and the URL does not exist yet, returns **202** with `{ status: 'pending', request }`: the flux goes through the admin approval queue instead of being created.",
        tags: ['UI — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "The user's ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['provider', 'url'],
                properties: {
                  provider: {
                    type: 'string',
                    description:
                      'See GET /connectors/providers for the available list',
                  },
                  url: {
                    type: 'string',
                    example: 'https://github.com/facebook/react',
                  },
                  config: { type: 'object', example: {} },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Flux added',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    repository: {
                      $ref: '#/components/schemas/UserRepository',
                    },
                  },
                },
              },
            },
          },
          202: {
            description:
              '`manual` provider: request created, awaiting admin approval',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'pending' },
                    request: { $ref: '#/components/schemas/FluxRequest' },
                  },
                },
              },
            },
          },
          400: { description: 'provider and url required' },
          401: { description: 'Unauthenticated' },
          403: { description: 'Access denied' },
          409: {
            description: 'Already subscribed, or a request is already pending',
          },
        },
      },
    },
    '/ui/users/{userId}/repositories/{linkId}': {
      delete: {
        summary: 'Remove a flux from a user',
        description:
          '**User**: deletes the link. If this flux is no longer subscribed by any other user, also deletes the repository and all the associated connector data.\n\n**Admin**: always deletes the repository and all the associated connector data, regardless of the subscriber count.',
        tags: ['UI — Users'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "The user's ID",
          },
          {
            name: 'linkId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'The user_repository link ID',
          },
        ],
        responses: {
          200: {
            description: 'Flux removed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Access denied' },
          404: { description: 'Flux not found' },
        },
      },
    },
    '/ui/repositories': {
      post: {
        summary: 'Create a repository (admin)',
        description:
          'Creates the repository, or updates its type and config if the URL already exists.',
        tags: ['Admin — Repositories'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url', 'type'],
                properties: {
                  url: { type: 'string' },
                  type: {
                    type: 'string',
                    description:
                      'See GET /connectors/providers for the available list',
                  },
                  config: { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Repository created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    url: { type: 'string' },
                    type: { type: 'string' },
                  },
                },
              },
            },
          },
          400: { description: 'Missing url or type' },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
        },
      },
      get: {
        summary: 'List all repositories (admin)',
        tags: ['Admin — Repositories'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'List of repositories with subscriber count',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    repositories: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer' },
                          url: { type: 'string' },
                          type: { type: 'string' },
                          config: { type: 'object' },
                          subscriber_count: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
        },
      },
    },
    '/ui/repositories/{repoId}': {
      delete: {
        summary: 'Delete a repository completely (admin)',
        description:
          'Deletes the connector data, every user_repository link and the repository.',
        tags: ['Admin — Repositories'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'repoId',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          200: {
            description: 'Repository deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
          404: { description: 'Repository not found' },
        },
      },
    },
    '/ui/repositories/{repoId}/data': {
      delete: {
        summary: "Delete only a repository's connector data (admin)",
        description:
          'Empties the connector_* table for this repository without deleting the repository or the subscriptions.',
        tags: ['Admin — Repositories'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'repoId',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          200: {
            description: 'Data deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
          403: { description: 'Admin role required' },
          404: { description: 'Repository not found' },
        },
      },
    },
    '/providers/{provider}/fluxes': {
      get: {
        summary: "List a provider's existing fluxes",
        description:
          "Returns every source of this provider with, for each, the authenticated user's subscription state. Generic: works for any provider.",
        tags: ['Flux'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'List of fluxes',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fluxes: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ProviderFlux' },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated' },
        },
      },
    },
    '/providers/{provider}/fluxes/{id}/subscribe': {
      post: {
        summary: 'Subscribe to an existing flux',
        tags: ['Flux'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          201: { description: 'Subscription created' },
          401: { description: 'Unauthenticated' },
          404: { description: 'Flux not found for this provider' },
          409: { description: 'Already subscribed' },
        },
      },
      delete: {
        summary: 'Unsubscribe from a flux',
        description:
          'Deletes only the subscription — the source may have other subscribers.',
        tags: ['Flux'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          200: { description: 'Unsubscribed' },
          401: { description: 'Unauthenticated' },
          404: { description: 'Not subscribed to this flux' },
        },
      },
    },
    '/ui/providers': {
      get: {
        summary: 'Providers + their flux-approval mode (admin)',
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'List of providers',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    providers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          displayName: { type: 'string' },
                          flux_approval: {
                            type: 'string',
                            enum: ['auto', 'manual'],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Admin role required' },
        },
      },
    },
    '/ui/providers/{name}': {
      patch: {
        summary: "Change a provider's flux-adding mode (admin)",
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['flux_approval'],
                properties: {
                  flux_approval: { type: 'string', enum: ['auto', 'manual'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Mode updated' },
          400: { description: "flux_approval must be 'auto' or 'manual'" },
          403: { description: 'Admin role required' },
          404: { description: 'Provider not found' },
        },
      },
    },
    '/ui/flux-requests': {
      get: {
        summary: 'List all flux requests (admin)',
        description:
          'Requests awaiting approval, across every provider in `manual` mode.',
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description:
              "List of requests with the provider and requester's e-mail",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requests: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/FluxRequest' },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Admin role required' },
        },
      },
    },
    '/ui/flux-requests/{id}/approve': {
      post: {
        summary: 'Approve a flux request (admin)',
        description:
          "Creates (or reuses) the source under the request's provider, subscribes the requester and moves the request to `approved`. Optional body: `{ config }`.",
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: {
            description: 'Request approved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    repository_id: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Admin role required' },
          404: { description: 'Request not found' },
          409: {
            description:
              'Request already approved, or URL already attached to another provider',
          },
        },
      },
    },
    '/ui/flux-requests/{id}/reject': {
      post: {
        summary: 'Reject a flux request (admin)',
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: 'Request rejected' },
          403: { description: 'Admin role required' },
          404: { description: 'Request not found' },
          409: { description: 'Request is not pending' },
        },
      },
    },
  },
}
