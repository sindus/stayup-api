-- One-off migration: merges the 5 existing `connector_<name>` tables into the
-- new single `connector_item` table (see schema.sql).
--
-- Script NOT run automatically — run it manually, after applying schema.sql
-- (which creates `connector_item`):
--   psql "$DATABASE_URL" -f scripts/migrate-connector-item.sql
--
-- The old `connector_<name>` tables are NOT dropped here — they stay readable,
-- as a safety net, until the connectors' switchover is validated in prod. See
-- scripts/drop-doc.sql for the equivalent drop script, to write once that
-- validation is done.
--
-- The original `id`s are not preserved: they are not unique across the 5 source
-- tables (each has its own sequence). Nothing references `connector_<name>.id`
-- elsewhere in the schema, so reassigning them is safe.

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
