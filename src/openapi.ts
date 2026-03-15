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
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          username: { type: 'string' },
          role: { type: 'string', enum: ['user', 'admin'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      UserProvider: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          provider_type: {
            type: 'string',
            enum: ['repository', 'profile'],
            description: 'Nom de la table provider',
          },
          provider_id: { type: 'integer' },
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
        summary: 'Connexion',
        tags: ['Authentification'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'sikander' },
                  password: { type: 'string', example: 'monmotdepasse' },
                },
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
          401: { description: 'Identifiants invalides' },
        },
      },
    },
    '/connectors': {
      get: {
        summary: 'Toutes les données des connecteurs',
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
        summary: 'Dernière entrée par provider pour chaque connecteur',
        tags: ['Connecteurs'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Dernier contenu par provider_id',
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
        summary: "Données d'un connecteur spécifique",
        tags: ['Connecteurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'changelog' },
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
    '/users': {
      get: {
        summary: 'Liste tous les utilisateurs',
        tags: ['Utilisateurs'],
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
        tags: ['Utilisateurs'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['user', 'admin'],
                    default: 'user',
                  },
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
                  properties: { user: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
          400: { description: 'Champs manquants ou rôle invalide' },
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
          409: { description: "Nom d'utilisateur déjà pris" },
        },
      },
    },
    '/users/{id}': {
      patch: {
        summary: 'Modifier un utilisateur',
        tags: ['Utilisateurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string' },
                  role: { type: 'string', enum: ['user', 'admin'] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Utilisateur mis à jour',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { user: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
          400: { description: 'Corps vide ou rôle invalide' },
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
          404: { description: 'Utilisateur introuvable' },
          409: { description: "Nom d'utilisateur déjà pris" },
        },
      },
      delete: {
        summary: 'Supprimer un utilisateur',
        tags: ['Utilisateurs'],
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
          200: {
            description: 'Utilisateur supprimé',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { user: { $ref: '#/components/schemas/User' } },
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
    '/user/{username}/providers': {
      get: {
        summary: 'Liste les providers abonnés par un utilisateur',
        tags: ['Providers'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'username',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'sikander' },
          },
        ],
        responses: {
          200: {
            description: 'Liste des abonnements',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    providers: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/UserProvider' },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès interdit' },
          404: { description: 'Utilisateur introuvable' },
        },
      },
      post: {
        summary: 'Abonner un utilisateur à un provider',
        tags: ['Providers'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'username',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'sikander' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['provider_type', 'provider_id'],
                properties: {
                  provider_type: {
                    type: 'string',
                    enum: ['repository', 'profile'],
                    description: 'Table du provider',
                  },
                  provider_id: {
                    type: 'integer',
                    description: 'ID du provider dans sa table',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Abonnement créé',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    provider: { $ref: '#/components/schemas/UserProvider' },
                  },
                },
              },
            },
          },
          400: { description: 'Champs manquants' },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès interdit' },
          404: { description: 'Utilisateur ou provider introuvable' },
          409: { description: 'Déjà abonné' },
        },
      },
    },
    '/user/{username}/providers/{id}': {
      delete: {
        summary: "Désabonner un utilisateur d'un provider",
        tags: ['Providers'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'username',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'sikander' },
          },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
            description: "ID de l'abonnement (user_providers.id)",
          },
        ],
        responses: {
          200: {
            description: 'Abonnement supprimé',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    provider: { $ref: '#/components/schemas/UserProvider' },
                  },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès interdit' },
          404: { description: 'Abonnement introuvable' },
        },
      },
    },
    '/feed/{username}': {
      get: {
        summary: 'Fil de contenu personnalisé',
        description:
          "Retourne le dernier contenu de chaque connecteur pour les providers auxquels l'utilisateur est abonné.",
        tags: ['Feed'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'username',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'sikander' },
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
                    feed: {
                      type: 'object',
                      additionalProperties: { type: 'array', items: {} },
                      example: {
                        changelog: [
                          {
                            id: 1,
                            provider_id: 3,
                            version: '1.2.0',
                            content: '...',
                            executed_at: '2026-03-15T10:00:00Z',
                            success: true,
                          },
                        ],
                        youtube: [],
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès interdit' },
          404: { description: 'Utilisateur introuvable' },
        },
      },
    },
  },
}
