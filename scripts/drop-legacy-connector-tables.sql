-- Drops the old connector_<provider> tables, replaced by the single
-- `connector_item` table (discriminating `provider` column).
-- Script NOT run automatically — run it manually, once every connector has
-- switched to /connector-api and is validated in prod:
--   psql "$DATABASE_URL" -f scripts/drop-legacy-connector-tables.sql
--
-- No foreign-key constraint between them: order does not matter.

DROP TABLE IF EXISTS connector_changelog;
DROP TABLE IF EXISTS connector_github_trending;
DROP TABLE IF EXISTS connector_rss;
DROP TABLE IF EXISTS connector_scrap;
DROP TABLE IF EXISTS connector_youtube;
