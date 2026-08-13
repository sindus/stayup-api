-- Suppression de la feature Documentation.
-- Script NON exécuté automatiquement — à lancer manuellement :
--   psql "$DATABASE_URL" -f scripts/drop-doc.sql
--
-- Ordre imposé par les clés étrangères : les tables référençant
-- doc_registry doivent tomber avant elle.

DROP TABLE IF EXISTS connector_doc;
DROP TABLE IF EXISTS user_doc_registry;
DROP TABLE IF EXISTS doc_request;
DROP TABLE IF EXISTS doc_registry;
