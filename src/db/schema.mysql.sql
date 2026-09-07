-- MySQL / MariaDB schema — the equivalent of schema.sql for these two engines.
--
-- Tables and columns carry exactly the same names as under PostgreSQL: that is
-- what lets a provider be documented once, whatever the engine. Only the types
-- change, where MySQL requires it:
--
--   SERIAL       -> INT AUTO_INCREMENT
--   JSONB        -> JSON (MariaDB makes it a LONGTEXT: the adapter handles both)
--   TIMESTAMPTZ  -> DATETIME(3), written in UTC
--   BOOLEAN      -> TINYINT(1)
--
-- URLs exceed a TEXT's indexable length: they are VARCHAR(512).

-- ─── Core ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repository (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  url        VARCHAR(512) NOT NULL UNIQUE,
  type       VARCHAR(64) NOT NULL,
  config     JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Provider registry ──────────────────────────────────────────────────────
-- Each provider declares its display name here at startup. Its absence is not an
-- error: the API falls back to the capitalized provider name.

CREATE TABLE IF NOT EXISTS provider_registry (
  name          VARCHAR(64) PRIMARY KEY,
  display_name  VARCHAR(255) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 100,
  -- Display manifest declared by the provider (see
  -- docs/self-hosting-and-providers.md). NULL = generic rendering on the apps.
  template      JSON,
  -- 'auto' : flux added immediately; 'manual' : a request an admin must approve.
  flux_approval VARCHAR(16) NOT NULL DEFAULT 'auto',
  -- Content retention override (days) set by an admin. NULL = follows the
  -- global default (app_setting.content_retention_days). On an existing database:
  --   ALTER TABLE provider_registry ADD COLUMN retention_days INT NULL;
  retention_days INT NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- Instance settings an admin changes that have no table of their own.
-- Today: content_retention_days (global retention default, in days).
CREATE TABLE IF NOT EXISTS app_setting (
  `key` VARCHAR(64) PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── Content collected by providers ────────────────────────────────────────
-- A single table for every provider (discriminating `provider` column), instead
-- of one `connector_<name>` table per provider. `content` stays an opaque
-- string: its shape belongs to the provider, the API does not interpret it.
-- `params` is only used by `scrap` today.

CREATE TABLE IF NOT EXISTS connector_item (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  provider      VARCHAR(64) NOT NULL,
  repository_id INT NOT NULL,
  version       VARCHAR(255),
  content       TEXT NOT NULL,
  params        JSON,
  datetime      DATETIME(3),
  executed_at   DATETIME(3) NOT NULL,
  success       TINYINT(1) NOT NULL,
  INDEX connector_item_provider_repo_idx (provider, repository_id, executed_at),
  FOREIGN KEY (repository_id) REFERENCES repository(id)
);

-- ─── Connector API keys ───────────────────────────────────────────────────
-- A connector no longer has direct database access: it authenticates against
-- the API with a key, scoped to a single `provider`. `key_hash` is a SHA-256 of
-- the key (an already high-entropy secret, not a human password). `key_prefix`
-- (first 8 characters) identifies a key in the admin UI without ever showing the
-- full secret again.

CREATE TABLE IF NOT EXISTS connector_key (
  id           VARCHAR(64) PRIMARY KEY,
  provider     VARCHAR(64) NOT NULL,
  name         VARCHAR(255) NOT NULL,
  key_hash     VARCHAR(64) NOT NULL UNIQUE,
  key_prefix   VARCHAR(16) NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3),
  revoked_at   DATETIME(3)
);

-- ─── Accounts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `user` (
  id             VARCHAR(64) PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  email          VARCHAR(320) NOT NULL UNIQUE,
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  image          TEXT,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS session (
  id         VARCHAR(64) PRIMARY KEY,
  expires_at DATETIME(3) NOT NULL,
  token      VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip_address VARCHAR(64),
  user_agent TEXT,
  user_id    VARCHAR(64) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account (
  id                       VARCHAR(64) PRIMARY KEY,
  account_id               VARCHAR(320) NOT NULL,
  provider_id              VARCHAR(64) NOT NULL,
  user_id                  VARCHAR(64) NOT NULL,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  DATETIME(3),
  refresh_token_expires_at DATETIME(3),
  scope                    TEXT,
  password                 TEXT,
  created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification (
  id         VARCHAR(64) PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL,
  value      TEXT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Pending sign-ups (REGISTRATION_MODE=approval) ─────────────────────────
-- In `approval` mode, a new account lands here and does not exist in `user`
-- yet: it cannot log in until an admin approves it.

CREATE TABLE IF NOT EXISTS pending_user (
  id               VARCHAR(64) PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(320) NOT NULL UNIQUE,
  password_hash    TEXT,
  oauth_provider   VARCHAR(64),
  oauth_account_id VARCHAR(320),
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Admins ───────────────────────────────────────────────────────────────────
-- Administration identities, distinct from user accounts. The first super
-- admin is created from the command line; the others from the UI.

CREATE TABLE IF NOT EXISTS admin (
  id            VARCHAR(64) PRIMARY KEY,
  email         VARCHAR(320) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  is_super      TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Subscriptions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            VARCHAR(64) PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  repository_id INT NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_user_repository (user_id, repository_id),
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repository(id)
);

-- ─── Secondary databases ─────────────────────────────────────────────────
-- Read-only databases containing only connector_* tables. The API aggregates
-- their content into the feeds; it never writes to them. `url_enc`: encrypted
-- connection string (see db/secretbox.ts).

CREATE TABLE IF NOT EXISTS data_source (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  url_enc    TEXT NOT NULL,
  engine     VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS external_subscription (
  id             VARCHAR(64) PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,
  data_source_id INT NOT NULL,
  provider       VARCHAR(64) NOT NULL,
  source_url     VARCHAR(512) NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_external_subscription (user_id, data_source_id, source_url),
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE,
  FOREIGN KEY (data_source_id) REFERENCES data_source(id) ON DELETE CASCADE
);

-- ─── Flux requests (approval queue) ────────────────────────────────────────
-- Renamed from `scrap_request`. On an existing MySQL database, rename
-- manually: RENAME TABLE scrap_request TO flux_request;
--                ALTER TABLE flux_request ADD COLUMN provider VARCHAR(64) NOT NULL DEFAULT 'scrap';

CREATE TABLE IF NOT EXISTS flux_request (
  id         VARCHAR(64) PRIMARY KEY,
  user_id    VARCHAR(64) NOT NULL,
  provider   VARCHAR(64) NOT NULL DEFAULT 'scrap',
  url        VARCHAR(512) NOT NULL,
  status     VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE
);
