-- Migration ponctuelle : fusionne les 5 tables `connector_<name>` existantes
-- dans la nouvelle table unique `connector_item` (voir schema.sql).
--
-- Script NON exécuté automatiquement — à lancer manuellement, après avoir
-- appliqué schema.sql (qui crée `connector_item`) :
--   psql "$DATABASE_URL" -f scripts/migrate-connector-item.sql
--
-- Les anciennes tables `connector_<name>` ne sont PAS supprimées ici — elles
-- restent en lecture, en filet de sécurité, jusqu'à ce que la bascule des
-- connectors soit validée en prod. Voir scripts/drop-doc.sql pour le script
-- de suppression équivalent, à écrire une fois cette validation faite.
--
-- Les `id` d'origine ne sont pas préservés : ils ne sont pas uniques entre les
-- 5 tables sources (chacune a sa propre séquence). Rien ne référence
-- `connector_<name>.id` ailleurs dans le schéma, donc leur réattribution est
-- sans risque.

BEGIN;

INSERT INTO connector_item (provider, repository_id, version, content, datetime, executed_at, success)
  SELECT 'changelog', repository_id, version, content, datetime, executed_at, success
  FROM connector_changelog ORDER BY id;

INSERT INTO connector_item (provider, repository_id, version, content, datetime, executed_at, success)
  SELECT 'github_trending', repository_id, version, content, datetime, executed_at, success
  FROM connector_github_trending ORDER BY id;

INSERT INTO connector_item (provider, repository_id, content, datetime, executed_at, success)
  SELECT 'rss', repository_id, content, datetime, executed_at, success
  FROM connector_rss ORDER BY id;

INSERT INTO connector_item (provider, repository_id, content, params, executed_at, success)
  SELECT 'scrap', repository_id, content, params, executed_at, success
  FROM connector_scrap ORDER BY id;

INSERT INTO connector_item (provider, repository_id, version, content, datetime, executed_at, success)
  SELECT 'youtube', repository_id, version, content, datetime, executed_at, success
  FROM connector_youtube ORDER BY id;

COMMIT;
