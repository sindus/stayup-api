-- Schéma MySQL / MariaDB — l'équivalent de schema.sql pour ces deux moteurs.
--
-- Les tables et colonnes portent exactement les mêmes noms que sous PostgreSQL :
-- c'est ce qui permet à un provider d'être décrit une fois dans la documentation,
-- quel que soit le moteur. Seuls les types changent, là où MySQL l'impose :
--
--   SERIAL       -> INT AUTO_INCREMENT
--   JSONB        -> JSON (MariaDB en fait un LONGTEXT : l'adaptateur gère les deux)
--   TIMESTAMPTZ  -> DATETIME(3), écrit en UTC
--   BOOLEAN      -> TINYINT(1)
--
-- Les URL dépassent la longueur indexable d'un TEXT : elles sont en VARCHAR(512).

-- ─── Cœur ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repository (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  url        VARCHAR(512) NOT NULL UNIQUE,
  type       VARCHAR(64) NOT NULL,
  config     JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Registre des providers ───────────────────────────────────────────────────
-- Chaque provider y déclare son nom affiché au démarrage. Son absence n'est pas
-- une erreur : l'API retombe sur le nom du provider avec une majuscule.

CREATE TABLE IF NOT EXISTS provider_registry (
  name          VARCHAR(64) PRIMARY KEY,
  display_name  VARCHAR(255) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 100,
  -- Manifeste d'affichage déclaré par le provider (voir
  -- docs/self-hosting-and-providers.md). NULL = rendu générique côté apps.
  template      JSON,
  -- 'auto' : ajout de flux immédiat ; 'manual' : demande à valider par un admin.
  flux_approval VARCHAR(16) NOT NULL DEFAULT 'auto',
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Contenu collecté par les providers ──────────────────────────────────────
-- Une seule table pour tous les providers (colonne `provider` discriminante),
-- à la place d'une table `connector_<name>` par provider. `content` reste une
-- chaîne opaque : sa forme appartient au provider, l'API ne l'interprète pas.
-- `params` ne sert aujourd'hui qu'à `scrap`.

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

-- ─── Clés d'API des connectors ────────────────────────────────────────────────
-- Un connector n'a plus d'accès direct à la base : il s'authentifie auprès de
-- l'API avec une clé, scopée à un seul `provider`. `key_hash` est un SHA-256 de
-- la clé (secret déjà à haute entropie, pas un mot de passe humain). `key_prefix`
-- (8 premiers caractères) identifie une clé dans l'interface admin sans jamais
-- réafficher le secret complet.

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

-- ─── Comptes ──────────────────────────────────────────────────────────────────

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

-- ─── Inscriptions en attente (REGISTRATION_MODE=approval) ────────────────────
-- En mode `approval`, un compte neuf atterrit ici et n'existe pas encore dans
-- `user` : il ne peut pas se connecter tant qu'un admin ne l'a pas validé.

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
-- Identités d'administration, distinctes des comptes utilisateurs. Le premier
-- super admin est créé en ligne de commande ; les autres depuis l'interface.

CREATE TABLE IF NOT EXISTS admin (
  id            VARCHAR(64) PRIMARY KEY,
  email         VARCHAR(320) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  is_super      TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ─── Abonnements ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_repository (
  id            VARCHAR(64) PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  repository_id INT NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_user_repository (user_id, repository_id),
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repository(id)
);

-- ─── Bases de données secondaires ──────────────────────────────────────────
-- Bases en lecture seule ne contenant que des tables connector_*. L'API agrège
-- leur contenu dans les feeds ; elle n'y écrit jamais. `url_enc` : chaîne de
-- connexion chiffrée (voir db/secretbox.ts).

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

-- ─── Flux requests (file d'approbation) ──────────────────────────────────────
-- Renommée depuis `scrap_request`. Sur une base MySQL existante, renommer
-- manuellement : RENAME TABLE scrap_request TO flux_request;
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
