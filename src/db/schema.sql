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
  name          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  -- Manifeste d'affichage déclaré par le provider pour les apps (forme libre,
  -- voir docs/self-hosting-and-providers.md). NULL = les apps rendent en générique.
  template      JSONB,
  -- 'auto'  : l'ajout d'un flux par un utilisateur crée la source immédiatement.
  -- 'manual': l'ajout crée une demande à valider par un admin (voir flux_request).
  flux_approval TEXT NOT NULL DEFAULT 'auto',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Registre antérieur à la colonne `template` : on l'ajoute sans rien réécrire.
ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS template JSONB;

-- Colonne `flux_approval` : ajoutée une seule fois. `scrap` est semé en 'manual'
-- au moment de la création de la colonne uniquement — pour ne jamais réécrire un
-- choix fait ensuite par un admin.
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
-- En mode `approval`, un nouveau compte atterrit ici et n'existe pas encore dans
-- "user" : il ne peut pas se connecter. Un admin le valide (ligne recopiée dans
-- "user"/"account") ou le rejette (ligne supprimée). En mode `open` cette table
-- n'est jamais alimentée.
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
-- Identités d'administration, distinctes des comptes utilisateurs (pas de feed,
-- pas d'abonnement). Le premier super admin est créé en ligne de commande
-- (scripts/create-admin.ts) ; les admins « normaux » se gèrent ensuite depuis
-- l'interface. `is_super` = peut gérer les autres admins.

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
-- Bases supplémentaires, en lecture seule, qui ne contiennent que des tables
-- connector_*. L'API agrège leur contenu dans les feeds ; elle n'y écrit jamais.
-- `url_enc` : chaîne de connexion chiffrée (voir db/secretbox.ts).

CREATE TABLE IF NOT EXISTS data_source (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  url_enc    TEXT NOT NULL,
  engine     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Abonnement d'un utilisateur à un flux vivant dans une base secondaire. Le flux
-- y est identifié par son URL — les id numériques ne traversent pas les bases.

CREATE TABLE IF NOT EXISTS external_subscription (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  data_source_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, data_source_id, source_url)
);

-- ─── Flux requests (file d'approbation) ──────────────────────────────────────
-- Renommée depuis `scrap_request` : la file vaut pour tout provider en mode
-- `manual`, pas seulement le scraping. Le RENAME migre les lignes existantes ;
-- il est sans effet sur une base neuve (la table est alors créée juste après).

ALTER TABLE IF EXISTS scrap_request RENAME TO flux_request;

CREATE TABLE IF NOT EXISTS flux_request (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'scrap',
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lignes migrées de `scrap_request` : elles n'ont pas la colonne `provider`.
ALTER TABLE flux_request ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'scrap';
