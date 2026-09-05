-- Suppression des anciennes tables connector_<provider>, remplacées par la
-- table unique `connector_item` (colonne `provider` discriminante).
-- Script NON exécuté automatiquement — à lancer manuellement, une fois tous
-- les connectors basculés sur /connector-api et validés en prod :
--   psql "$DATABASE_URL" -f scripts/drop-legacy-connector-tables.sql
--
-- Aucune contrainte de clé étrangère entre elles : ordre indifférent.

DROP TABLE IF EXISTS connector_changelog;
DROP TABLE IF EXISTS connector_github_trending;
DROP TABLE IF EXISTS connector_rss;
DROP TABLE IF EXISTS connector_scrap;
DROP TABLE IF EXISTS connector_youtube;
