export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'StayUp API',
    version: '2.1.0',
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
            description:
              'Nom du provider (dynamique — voir GET /connectors/providers)',
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
            description: 'Peut gérer les autres administrateurs.',
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
            description: "Abonnement de l'utilisateur courant à ce flux",
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
    '/auth/register': {
      post: {
        summary: 'Créer un compte utilisateur',
        description:
          'Inscription publique. Crée un utilisateur et retourne immédiatement un JWT.',
        tags: ['Authentification'],
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
            description: 'Compte créé, token JWT retourné',
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
          409: { description: 'Email déjà utilisé' },
        },
      },
    },
    '/auth/oauth/google': {
      get: {
        summary: 'Initier le flux OAuth Google',
        description: 'Génère un state JWT et redirige vers Google OAuth.',
        tags: ['Authentification'],
        responses: {
          302: { description: 'Redirection vers Google' },
        },
      },
    },
    '/auth/oauth/google/callback': {
      get: {
        summary: 'Callback OAuth Google',
        description:
          "Échange le code, crée/trouve l'utilisateur, redirige vers l'UI avec un JWT.",
        tags: ['Authentification'],
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
            description: "Redirection vers l'UI (/api/auth/callback?token=JWT)",
          },
          400: { description: 'State invalide ou code manquant' },
        },
      },
    },
    '/auth/oauth/github': {
      get: {
        summary: 'Initier le flux OAuth GitHub',
        description: 'Génère un state JWT et redirige vers GitHub OAuth.',
        tags: ['Authentification'],
        responses: {
          302: { description: 'Redirection vers GitHub' },
        },
      },
    },
    '/auth/oauth/github/callback': {
      get: {
        summary: 'Callback OAuth GitHub',
        description:
          "Échange le code, crée/trouve l'utilisateur, redirige vers l'UI avec un JWT.",
        tags: ['Authentification'],
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
            description: "Redirection vers l'UI (/api/auth/callback?token=JWT)",
          },
          400: { description: 'State invalide ou code manquant' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Connexion — obtenir un token JWT',
        description:
          'Authentification admin (username = e-mail du compte admin + password) ' +
          'ou utilisateur (email + password). Les admins sont stockés en base ' +
          '(table `admin`) ; le premier est créé via `npm run create-admin`.',
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
                      username: {
                        type: 'string',
                        format: 'email',
                        example: 'root@example.com',
                      },
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
    '/auth/me': {
      get: {
        summary: 'Identité portée par le token',
        description:
          "Valide la signature et l'expiration du token, puis renvoie son identité. " +
          'Destiné aux clients qui ne connaissent pas JWT_SECRET et ne peuvent donc ' +
          'que décoder le payload sans le vérifier.',
        tags: ['Authentification'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Identité du porteur du token',
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
                        'Vrai pour un super admin (gère les autres admins).',
                    },
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                  },
                },
              },
            },
          },
          401: { description: 'Token absent, invalide ou expiré' },
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
                      description:
                        'Une clé par provider découvert (voir GET /connectors/providers)',
                      additionalProperties: { type: 'array', items: {} },
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
    '/connectors/providers': {
      get: {
        summary: 'Liste des providers découverts',
        description:
          "Providers disponibles (table connector_<name> présente en base), avec leur nom affiché depuis provider_registry. Sert à construire une UI dynamique (onglets, sélecteur d'ajout de flux) sans tirer toutes les données.",
        tags: ['Connecteurs'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Liste des providers',
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
                              "Mode d'ajout d'un flux par un utilisateur : `auto` (créé tout de suite) ou `manual` (demande à valider par un admin).",
                          },
                          template: {
                            type: 'object',
                            nullable: true,
                            description:
                              "Manifeste d'affichage que le provider déclare pour les apps (provider_registry.template). Relayé tel quel, non interprété par l'API ; absent si le provider n'en publie pas — les apps rendent alors en générique.",
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
            schema: { type: 'string' },
            description:
              'Nom du connecteur (sans le préfixe connector_) — voir GET /connectors/providers pour la liste disponible',
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
    '/ui/admins': {
      get: {
        summary: 'Lister les administrateurs (super admin)',
        tags: ['Admin — Administrateurs'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Liste des admins',
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
          403: { description: 'Super admin requis' },
        },
      },
      post: {
        summary: 'Créer un administrateur normal (super admin)',
        description:
          'Crée un admin non-super. Les super admins ne se créent qu’en ligne de commande.',
        tags: ['Admin — Administrateurs'],
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
          201: { description: 'Admin créé' },
          400: { description: 'Champs requis manquants' },
          403: { description: 'Super admin requis' },
          409: { description: 'Email déjà utilisé' },
        },
      },
    },
    '/ui/admins/me': {
      patch: {
        summary: 'Changer son propre mot de passe (admin)',
        tags: ['Admin — Administrateurs'],
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
          200: { description: 'Mot de passe changé' },
          400: { description: 'Champs requis manquants' },
          401: { description: 'Mot de passe actuel incorrect' },
        },
      },
    },
    '/ui/admins/{id}': {
      patch: {
        summary: 'Modifier un administrateur (super admin)',
        tags: ['Admin — Administrateurs'],
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
          200: { description: 'Admin modifié' },
          403: { description: 'Super admin requis' },
          404: { description: 'Admin introuvable' },
          409: { description: 'Email déjà utilisé' },
        },
      },
      delete: {
        summary: 'Supprimer un administrateur (super admin)',
        description:
          'Un super admin ne se supprime pas depuis l’interface, ni soi-même.',
        tags: ['Admin — Administrateurs'],
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
          200: { description: 'Admin supprimé' },
          403: { description: 'Super admin requis, ou cible super admin' },
          404: { description: 'Admin introuvable' },
          409: { description: 'On ne peut pas se supprimer soi-même' },
        },
      },
    },
    '/ui/users/{userId}': {
      get: {
        summary: "Profil d'un utilisateur",
        description: "Accessible par l'utilisateur lui-même ou un admin.",
        tags: ['UI — Utilisateurs'],
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
            description: "Profil de l'utilisateur",
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
          403: { description: 'Accès refusé' },
          404: { description: 'Utilisateur introuvable' },
        },
      },
      patch: {
        summary: 'Modifier un utilisateur',
        description: "Accessible par l'utilisateur lui-même ou un admin.",
        tags: ['UI — Utilisateurs'],
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
          403: { description: 'Accès refusé (self ou admin requis)' },
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
            description: "ID de l'utilisateur",
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
                      description:
                        'Une clé par provider découvert (voir GET /connectors/providers)',
                      additionalProperties: { type: 'array', items: {} },
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
            schema: { type: 'string' },
            description:
              'Voir GET /connectors/providers pour la liste disponible',
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
        description:
          "Si le provider est en mode `manual` et que l'appelant est un utilisateur (pas un admin) et que l'URL n'existe pas encore, renvoie **202** avec `{ status: 'pending', request }` : le flux passe par la file d'approbation admin au lieu d'être créé.",
        tags: ['UI — Utilisateurs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: "ID de l'utilisateur",
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
                      'Voir GET /connectors/providers pour la liste disponible',
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
          202: {
            description:
              'Provider `manual` : demande créée, en attente d’approbation admin',
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
          400: { description: 'provider et url requis' },
          401: { description: 'Non authentifié' },
          403: { description: 'Accès refusé' },
          409: { description: 'Déjà abonné, ou demande déjà en attente' },
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
            description: "ID de l'utilisateur",
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
    '/ui/repositories': {
      post: {
        summary: 'Créer un repository (admin)',
        description:
          'Crée le repository, ou met à jour son type et sa config si l’URL existe déjà.',
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
                      'Voir GET /connectors/providers pour la liste disponible',
                  },
                  config: { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Repository créé',
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
          400: { description: 'url ou type manquant' },
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
        },
      },
      get: {
        summary: 'Lister tous les repositories (admin)',
        tags: ['Admin — Repositories'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Liste des repositories avec nombre d'abonnés",
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
          401: { description: 'Non authentifié' },
          403: { description: 'Rôle admin requis' },
        },
      },
    },
    '/ui/repositories/{repoId}': {
      delete: {
        summary: 'Supprimer un repository complètement (admin)',
        description:
          'Supprime les données connector, tous les liens user_repository et le repository.',
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
            description: 'Repository supprimé',
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
          404: { description: 'Repository introuvable' },
        },
      },
    },
    '/ui/repositories/{repoId}/data': {
      delete: {
        summary:
          "Supprimer uniquement les données connector d'un repository (admin)",
        description:
          'Vide la table connector_* pour ce repository sans supprimer le repository ni les abonnements.',
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
            description: 'Données supprimées',
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
          404: { description: 'Repository introuvable' },
        },
      },
    },
    '/providers/{provider}/fluxes': {
      get: {
        summary: 'Lister les flux existants d’un provider',
        description:
          "Renvoie toutes les sources de ce provider avec, pour chacune, l'état d'abonnement de l'utilisateur authentifié. Générique : vaut pour n'importe quel provider.",
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
            description: 'Liste des flux',
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
          401: { description: 'Non authentifié' },
        },
      },
    },
    '/providers/{provider}/fluxes/{id}/subscribe': {
      post: {
        summary: 'S’abonner à un flux existant',
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
          201: { description: 'Abonnement créé' },
          401: { description: 'Non authentifié' },
          404: { description: 'Flux introuvable pour ce provider' },
          409: { description: 'Déjà abonné' },
        },
      },
      delete: {
        summary: 'Se désabonner d’un flux',
        description:
          'Supprime uniquement l’abonnement — la source peut avoir d’autres abonnés.',
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
          200: { description: 'Désabonnement effectué' },
          401: { description: 'Non authentifié' },
          404: { description: 'Non abonné à ce flux' },
        },
      },
    },
    '/ui/providers': {
      get: {
        summary: 'Providers + leur mode d’approbation de flux (admin)',
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Liste des providers',
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
          403: { description: 'Rôle admin requis' },
        },
      },
    },
    '/ui/providers/{name}': {
      patch: {
        summary: 'Changer le mode d’ajout de flux d’un provider (admin)',
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
          200: { description: 'Mode mis à jour' },
          400: { description: "flux_approval doit être 'auto' ou 'manual'" },
          403: { description: 'Rôle admin requis' },
          404: { description: 'Provider introuvable' },
        },
      },
    },
    '/ui/flux-requests': {
      get: {
        summary: 'Lister toutes les demandes de flux (admin)',
        description:
          'Demandes en attente d’approbation, tous providers en mode `manual` confondus.',
        tags: ['Admin — Providers'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description:
              'Liste des demandes avec provider et e-mail du demandeur',
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
          403: { description: 'Rôle admin requis' },
        },
      },
    },
    '/ui/flux-requests/{id}/approve': {
      post: {
        summary: 'Approuver une demande de flux (admin)',
        description:
          'Crée (ou réutilise) la source sous le provider de la demande, abonne le demandeur et passe la demande en `approved`. Body optionnel : `{ config }`.',
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
            description: 'Demande approuvée',
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
          403: { description: 'Rôle admin requis' },
          404: { description: 'Demande introuvable' },
          409: {
            description:
              'Demande déjà approuvée, ou URL déjà rattachée à un autre provider',
          },
        },
      },
    },
    '/ui/flux-requests/{id}/reject': {
      post: {
        summary: 'Rejeter une demande de flux (admin)',
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
          200: { description: 'Demande rejetée' },
          403: { description: 'Rôle admin requis' },
          404: { description: 'Demande introuvable' },
          409: { description: 'Demande non en attente' },
        },
      },
    },
  },
}
