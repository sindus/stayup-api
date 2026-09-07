-- Removes the Documentation feature.
-- Script NOT run automatically — run it manually:
--   psql "$DATABASE_URL" -f scripts/drop-doc.sql
--
-- Order imposed by foreign keys: the tables referencing doc_registry must be
-- dropped before it.

DROP TABLE IF EXISTS connector_doc;
DROP TABLE IF EXISTS user_doc_registry;
DROP TABLE IF EXISTS doc_request;
DROP TABLE IF EXISTS doc_registry;
