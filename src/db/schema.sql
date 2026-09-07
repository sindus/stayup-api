-- ─── Core ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repository (
  id         SERIAL PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Provider registry ──────────────────────────────────────────────────────────
-- Each provider (an independent project like stayup-cmd-*) has its own
-- connector_<name> table (created by that project, not by the API) and declares
-- its display name here at startup. The API discovers the list of available
-- providers via information_schema (connector_* tables) and enriches it with the
-- display_name found here.

CREATE TABLE IF NOT EXISTS provider_registry (
  name          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  -- Display manifest declared by the provider for the apps (free-form, see
  -- docs/self-hosting-and-providers.md). NULL = the apps render generically.
  template      JSONB,
  -- 'auto'  : a user adding a flux creates the source immediately.
  -- 'manual': adding creates a request an admin must approve (see flux_request).
  flux_approval TEXT NOT NULL DEFAULT 'auto',
  -- Content retention override (days), set by an admin. NULL = the provider
  -- follows the global default (app_setting.content_retention_days). Used by the
  -- centralized purge, see routes/maintenance.ts.
  retention_days INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Registry predating the `template` column: we add it without rewriting anything.
ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS template JSONB;

-- Registry predating `retention_days`: idempotent add.
ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS retention_days INTEGER;

-- ─── Instance settings ─────────────────────────────────────────────────────
-- A small KV for what an admin configures that has no table of its own. Today a
-- single key: `content_retention_days` (global content-retention default, in
-- days; 'off' = automatic purge disabled; absent = 30).
CREATE TABLE IF NOT EXISTS app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Column `flux_approval`: added once. `scrap` is seeded to 'manual' only when
-- the column is created — so as never to overwrite a choice an admin makes
-- afterwards.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'provider_registry'
      AND column_name = 'flux_approval'
  ) THEN
    ALTER TABLE provider_registry ADD COLUMN flux_approval TEXT NOT NULL DEFAULT 'auto';
    UPDATE provider_registry SET flux_approval = 'manual' WHERE name = 'scrap';
  END IF;
END $$;

-- ─── Content collected by providers ─────────────────────────────────────────
-- A single table for every provider (discriminating `provider` column), instead
-- of one `connector_<name>` table per provider. `content` stays an opaque
-- string: its shape belongs to the provider, the API does not interpret it (see
-- db/port.ts). `params` is only used by `scrap` today.

CREATE TABLE IF NOT EXISTS connector_item (
  id            SERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  version       TEXT,
  content       TEXT NOT NULL,
  params        JSONB,
  datetime      TIMESTAMPTZ,
  executed_at   TIMESTAMPTZ NOT NULL,
  success       BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_item_provider_repo_idx
  ON connector_item (provider, repository_id, executed_at DESC);

-- ─── Connector API keys ────────────────────────────────────────────────────
-- A connector no longer has direct database access: it authenticates against
-- the API with a key, scoped to a single `provider` (see middleware/auth.ts).
-- `key_hash` is a SHA-256 of the key — not bcrypt: it is an already high-entropy
-- secret generated server-side, not a human password to deliberately slow down.
-- `key_prefix` (first 8 characters) identifies a key in the admin UI without
-- ever showing the full secret again.

CREATE TABLE IF NOT EXISTS connector_key (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- ─── Auth (Better Auth — managed by stayup-ui) ────────────────────────────────

CREATE TABLE IF NOT EXISTS "user" (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image          TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
  access_token_expires_at  TIMESTAMP,
  refresh_token_expires_at TIMESTAMP,
  scope                    TEXT,
  password                 TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─── Pending sign-ups (REGISTRATION_MODE=approval) ───────────────────────────
-- In `approval` mode, a new account lands here and does not exist in "user"
-- yet: it cannot log in. An admin approves it (row copied into "user"/"account")
-- or rejects it (row deleted). In `open` mode this table is never populated.
CREATE TABLE IF NOT EXISTS pending_user (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT,
  oauth_provider   TEXT,
  oauth_account_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Admins ───────────────────────────────────────────────────────────────────
-- Administration identities, distinct from user accounts (no feed, no
-- subscription). The first super admin is created from the command line
-- (scripts/create-admin.ts); "normal" admins are then managed from the UI.
-- `is_super` = can manage the other admins.

CREATE TABLE IF NOT EXISTS admin (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_super      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── User subscriptions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, repository_id)
);

-- ─── Secondary data sources ─────────────────────────────────────────────────
-- Extra databases, read-only, that contain only connector_* tables. The API
-- aggregates their content into the feeds; it never writes to them.
-- `url_enc`: encrypted connection string (see db/secretbox.ts).

CREATE TABLE IF NOT EXISTS data_source (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  url_enc    TEXT NOT NULL,
  engine     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A user's subscription to a flux living in a secondary database. The flux is
-- identified there by its URL — numeric ids do not cross databases.

CREATE TABLE IF NOT EXISTS external_subscription (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  data_source_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, data_source_id, source_url)
);

-- ─── Flux requests (approval queue) ────────────────────────────────────────
-- Renamed from `scrap_request`: the queue applies to any provider in `manual`
-- mode, not just scraping. The RENAME migrates existing rows; it has no effect
-- on a fresh database (the table is then created right after).

ALTER TABLE IF EXISTS scrap_request RENAME TO flux_request;

CREATE TABLE IF NOT EXISTS flux_request (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'scrap',
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rows migrated from `scrap_request`: they lack the `provider` column.
ALTER TABLE flux_request ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'scrap';
