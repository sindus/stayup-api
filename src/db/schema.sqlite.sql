-- Schéma SQLite — l'équivalent de schema.sql pour un déploiement sur SQLite.
--
-- Les tables et colonnes portent exactement les mêmes noms que sous PostgreSQL :
-- c'est ce qui permet à un provider d'être décrit une fois dans la documentation,
-- quel que soit le moteur. Seuls les types changent, là où SQLite l'impose :
--
--   SERIAL       -> INTEGER PRIMARY KEY AUTOINCREMENT
--   JSONB        -> TEXT contenant du JSON (l'adaptateur sérialise/désérialise)
--   TIMESTAMPTZ  -> TEXT au format ISO 8601
--   BOOLEAN      -> INTEGER 0/1

PRAGMA foreign_keys = ON;

-- ─── Cœur ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repository (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Registre des providers ───────────────────────────────────────────────────
-- Chaque provider y déclare son nom affiché au démarrage. Son absence n'est pas
-- une erreur : l'API retombe sur le nom du provider avec une majuscule.

CREATE TABLE IF NOT EXISTS provider_registry (
  name          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  -- Manifeste d'affichage déclaré par le provider, JSON en TEXT (voir
  -- docs/self-hosting-and-providers.md). NULL = rendu générique côté apps.
  template      TEXT,
  -- 'auto' : ajout de flux immédiat ; 'manual' : demande à valider par un admin.
  flux_approval TEXT NOT NULL DEFAULT 'auto',
  -- Surcharge de rétention du contenu (jours) posée par un admin. NULL = suit le
  -- défaut global (app_setting.content_retention_days). Sur une base existante :
  --   ALTER TABLE provider_registry ADD COLUMN retention_days INTEGER;
  retention_days INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Réglages d'instance qu'un admin modifie et qui n'ont pas leur propre table.
-- Aujourd'hui : content_retention_days (défaut global de rétention, en jours).
CREATE TABLE IF NOT EXISTS app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── Contenu collecté par les providers ──────────────────────────────────────
-- Une seule table pour tous les providers (colonne `provider` discriminante),
-- à la place d'une table `connector_<name>` par provider. `content` reste une
-- chaîne opaque : sa forme appartient au provider, l'API ne l'interprète pas.
-- `params` ne sert aujourd'hui qu'à `scrap`.

CREATE TABLE IF NOT EXISTS connector_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  version       TEXT,
  content       TEXT NOT NULL,
  params        TEXT,
  datetime      TEXT,
  executed_at   TEXT NOT NULL,
  success       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_item_provider_repo_idx
  ON connector_item (provider, repository_id, executed_at DESC);

-- ─── Clés d'API des connectors ────────────────────────────────────────────────
-- Un connector n'a plus d'accès direct à la base : il s'authentifie auprès de
-- l'API avec une clé, scopée à un seul `provider`. `key_hash` est un SHA-256 de
-- la clé (secret déjà à haute entropie, pas un mot de passe humain). `key_prefix`
-- (8 premiers caractères) identifie une clé dans l'interface admin sans jamais
-- réafficher le secret complet.

CREATE TABLE IF NOT EXISTS connector_key (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

-- ─── Comptes ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user" (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL,
  provider_id              TEXT NOT NULL,
  user_id                  TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  TEXT,
  refresh_token_expires_at TEXT,
  scope                    TEXT,
  password                 TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Inscriptions en attente (REGISTRATION_MODE=approval) ────────────────────
-- En mode `approval`, un compte neuf atterrit ici et n'existe pas encore dans
-- "user" : il ne peut pas se connecter tant qu'un admin ne l'a pas validé.

CREATE TABLE IF NOT EXISTS pending_user (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT,
  oauth_provider   TEXT,
  oauth_account_id TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Admins ───────────────────────────────────────────────────────────────────
-- Identités d'administration, distinctes des comptes utilisateurs. Le premier
-- super admin est créé en ligne de commande ; les autres depuis l'interface.

CREATE TABLE IF NOT EXISTS admin (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_super      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Abonnements ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, repository_id)
);

-- ─── Bases de données secondaires ───────────────────────────────────────────
-- Bases en lecture seule ne contenant que des tables connector_*. L'API agrège
-- leur contenu dans les feeds ; elle n'y écrit jamais. `url_enc` : chaîne de
-- connexion chiffrée (voir db/secretbox.ts).

CREATE TABLE IF NOT EXISTS data_source (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url_enc    TEXT NOT NULL,
  engine     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS external_subscription (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  data_source_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, data_source_id, source_url)
);

-- ─── Flux requests (file d'approbation) ──────────────────────────────────────
-- Renommée depuis `scrap_request`. Sur une base SQLite existante, renommer
-- manuellement : ALTER TABLE scrap_request RENAME TO flux_request;
--                ALTER TABLE flux_request ADD COLUMN provider TEXT NOT NULL DEFAULT 'scrap';

CREATE TABLE IF NOT EXISTS flux_request (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'scrap',
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
