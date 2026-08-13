-- Base dédiée aux tests fonctionnels (cible par défaut de tests/functional).
-- Exécuté automatiquement par le conteneur postgres au premier démarrage.
-- Le schéma y est appliqué par les tests eux-mêmes (beforeAll).
CREATE DATABASE stayup_test;
