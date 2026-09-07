-- SQLite schema — the equivalent of schema.sql for a SQLite deployment.
--
-- Tables and columns carry exactly the same names as under PostgreSQL: that is
-- what lets a provider be documented once, whatever the engine. Only the types
-- change, where SQLite requires it:
--
--   SERIAL       -> INTEGER PRIMARY KEY AUTOINCREMENT
--   JSONB        -> TEXT containing JSON (the adapter serializes/deserializes)
--   TIMESTAMPTZ  -> TEXT in ISO 8601 format
--   BOOLEAN      -> INTEGER 0/1

PRAGMA foreign_keys = ON;

-- ─── Core ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repository (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Provider registry ──────────────────────────────────────────────────────
-- Each provider declares its display name here at startup. Its absence is not an
-- error: the API falls back to the capitalized provider name.

CREATE TABLE IF NOT EXISTS provider_registry (
  name          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  -- Display manifest declared by the provider, JSON in TEXT (see
  -- docs/self-hosting-and-providers.md). NULL = generic rendering on the apps.
  template      TEXT,
  -- 'auto' : flux added immediately; 'manual' : a request an admin must approve.
  flux_approval TEXT NOT NULL DEFAULT 'auto',
  -- Content retention override (days) set by an admin. NULL = follows the
  -- global default (app_setting.content_retention_days). On an existing database:
  --   ALTER TABLE provider_registry ADD COLUMN retention_days INTEGER;
  retention_days INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Instance settings an admin changes that have no table of their own.
-- Today: content_retention_days (global retention default, in days).
CREATE TABLE IF NOT EXISTS app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── Content collected by providers ────────────────────────────────────────
-- A single table for every provider (discriminating `provider` column), instead
-- of one `connector_<name>` table per provider. `content` stays an opaque
-- string: its shape belongs to the provider, the API does not interpret it.
-- `params` is only used by `scrap` today.

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

-- ─── Connector API keys ───────────────────────────────────────────────────
-- A connector no longer has direct database access: it authenticates against
-- the API with a key, scoped to a single `provider`. `key_hash` is a SHA-256 of
-- the key (an already high-entropy secret, not a human password). `key_prefix`
-- (first 8 characters) identifies a key in the admin UI without ever showing the
-- full secret again.

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

-- ─── Accounts ─────────────────────────────────────────────────────────────────

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

-- ─── Pending sign-ups (REGISTRATION_MODE=approval) ─────────────────────────
-- In `approval` mode, a new account lands here and does not exist in "user"
-- yet: it cannot log in until an admin approves it.

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
-- Administration identities, distinct from user accounts. The first super
-- admin is created from the command line; the others from the UI.

CREATE TABLE IF NOT EXISTS admin (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_super      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Subscriptions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, repository_id)
);

-- ─── Secondary databases ─────────────────────────────────────────────────
-- Read-only databases containing only connector_* tables. The API aggregates
-- their content into the feeds; it never writes to them. `url_enc`: encrypted
-- connection string (see db/secretbox.ts).

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

-- ─── Flux requests (approval queue) ────────────────────────────────────────
-- Renamed from `scrap_request`. On an existing SQLite database, rename
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
