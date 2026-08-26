-- ─── Core ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repository (
  id         SERIAL PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Provider registry ──────────────────────────────────────────────────────────
-- Chaque provider (projet indépendant type stayup-cmd-*) possède sa propre table
-- connector_<name> (créée par ce projet, pas par l'API) et déclare ici son nom affiché
-- au démarrage. L'API découvre la liste des providers disponibles via
-- information_schema (tables connector_*) et enrichit avec le display_name trouvé ici.

CREATE TABLE IF NOT EXISTS provider_registry (
  name         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- ─── User subscriptions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repository(id),
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, repository_id)
);

-- ─── Scrap URL requests ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scrap_request (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
