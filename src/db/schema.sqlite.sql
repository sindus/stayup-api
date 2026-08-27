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
  name         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
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

-- ─── Abonnements ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, repository_id)
);

-- ─── Demandes de scraping ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scrap_request (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
