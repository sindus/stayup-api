export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'StayUp API',
    version: '0.1.0',
    description:
      'API HTTP exposant les données StayUp — connecteurs, utilisateurs et fils de contenu.',
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
        description: 'Token JWT obtenu via POST /auth/login',
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
            enum: ['changelog', 'youtube', 'rss', 'scrap'],
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
        tags: ['Général'],
        responses: {
          200: {
            description: 'API opérationnelle',
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
    '/auth/login': {
      post: {
        summary: 'Connexion — obtenir un token JWT',
        description:
          'Authentification admin (username + password) ou utilisateur (email + password).',
        tags: ['Authentification'],
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
                      username: { type: 'string', example: 'admin' },
                      password: { type: 'string', example: 'Azerty123!' },
                    },
                  },
                  {
                    title: 'Utilisateur',
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email: {
                        type: 'string',
                        format: 'email',
                        example: 'user@example.com',
                      },
                      password: { type: 'string', example: 'monmotdepasse' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Token JWT',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { token: { type: 'string' } },
                },
              },
            },
          },
          400: { description: 'Champs requis manquants' },
          401: { description: 'Identifiants invalides' },
        },
      },
    },
    '/connectors': {
      get: {
        summary: 'Toutes les données de tous les connecteurs',
        tags: ['Connecteurs'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Données de chaque table connector_*',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connectors: {
                      type: 'object',
                      additionalProperties: { type: 'array', items: {} },
                      example: {
                        changelog: [],
                        youtube: [],
                        rss: [],
                        scrap: [],
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
        },
      },
    },
    '/connectors/latest': {
      get: {
        summary: 'Dernière entrée par source pour chaque connecteur',
        tags: ['Connecteurs'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Dernier contenu par repository_id',
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
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
        },
      },
    },
    '/connectors/{name}': {
      get: {
        summary: 'Dernière entrée par source pour un connecteur spécifique',
        tags: ['Connecteurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['changelog', 'youtube', 'rss', 'scrap'],
            },
            description: 'Nom du connecteur (sans le préfixe connector_)',
          },
        ],
        responses: {
          200: {
            description: 'Données du connecteur',
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
          401: { description: 'Non authentifié' },
          404: { description: 'Connecteur introuvable' },
        },
      },
    },
    '/ui/users': {
      get: {
        summary: 'Lister tous les utilisateurs',
        tags: ['Admin — Utilisateurs'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Liste des utilisateurs',
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
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
        },
      },
      post: {
        summary: 'Créer un utilisateur',
        tags: ['Admin — Utilisateurs'],
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
                  password: { type: 'string', example: 'monmotdepasse' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Utilisateur créé',
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
          400: { description: 'Champs requis manquants' },
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
          409: { description: 'Email déjà utilisé' },
        },
      },
    },
    '/ui/users/{userId}': {
      patch: {
        summary: 'Modifier un utilisateur',
        tags: ['Admin — Utilisateurs'],
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
            description: 'Utilisateur modifié',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
          404: { description: 'Utilisateur introuvable' },
        },
      },
      delete: {
        summary: 'Supprimer un utilisateur',
        tags: ['Admin — Utilisateurs'],
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
            description: 'Utilisateur supprimé',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
          404: { description: 'Utilisateur introuvable' },
        },
      },
    },
    '/ui/users/{userId}/feed': {
      get: {
        summary: "Fil de contenu complet d'un utilisateur",
        description:
          "Retourne les flux configurés et le contenu associé (tous connecteurs). Accessible par l'utilisateur lui-même ou un admin.",
        tags: ['UI — Utilisateurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "ID de l'utilisateur (Better Auth)",
          },
        ],
        responses: {
          200: {
            description: "Feed de l'utilisateur",
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
                      properties: {
                        changelog: { type: 'array', items: {} },
                        youtube: { type: 'array', items: {} },
                        rss: { type: 'array', items: {} },
                        scrap: { type: 'array', items: {} },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès refusé' },
        },
      },
    },
    '/ui/users/{userId}/feed/{connector}': {
      get: {
        summary: "Fil de contenu d'un utilisateur pour un connecteur",
        description:
          "Retourne uniquement le contenu du connecteur spécifié pour l'utilisateur. Accessible par l'utilisateur lui-même ou un admin.",
        tags: ['UI — Utilisateurs'],
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
            schema: {
              type: 'string',
              enum: ['changelog', 'youtube', 'rss', 'scrap'],
            },
          },
        ],
        responses: {
          200: {
            description: 'Contenu du connecteur',
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
          401: { description: 'Non authentifié' },
          403: { description: 'Accès refusé' },
          404: { description: 'Connecteur inconnu' },
        },
      },
    },
    '/ui/users/{userId}/repositories': {
      post: {
        summary: 'Ajouter un flux à un utilisateur',
        tags: ['UI — Utilisateurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "ID de l'utilisateur (Better Auth)",
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
                    enum: ['changelog', 'youtube', 'rss', 'scrap'],
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
            description: 'Flux ajouté',
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
          400: { description: 'provider et url requis' },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès refusé' },
          409: { description: 'Déjà abonné à ce flux' },
        },
      },
    },
    '/ui/users/{userId}/repositories/{linkId}': {
      delete: {
        summary: "Supprimer un flux d'un utilisateur",
        description:
          "**Utilisateur** : supprime le lien. Si ce flux n'est plus abonné par aucun autre utilisateur, supprime aussi le repository et toutes les données connector associées.\n\n**Admin** : supprime toujours le repository et toutes les données connector associées, quel que soit le nombre d'abonnés.",
        tags: ['UI — Utilisateurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "ID de l'utilisateur (Better Auth)",
          },
          {
            name: 'linkId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'ID du lien user_repository',
          },
        ],
        responses: {
          200: {
            description: 'Flux supprimé',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès refusé' },
          404: { description: 'Flux introuvable' },
        },
      },
    },
  },
}
