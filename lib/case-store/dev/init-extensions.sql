-- First-boot extension provisioning for the local-dev Postgres
-- (docker-compose, see compose.yaml at the repo root). Mounted into
-- /docker-entrypoint-initdb.d, so it runs ONCE as the superuser when the
-- data volume is empty — the same split production and the test harness use:
-- extensions install once under the superuser at provisioning time, and the
-- migrate runner (a non-superuser, which can't CREATE EXTENSION) applies only
-- the schema migrations afterward.
--
-- Provision the compiler and historical migration dependencies (see
-- lib/case-store/CLAUDE.md → "Required Postgres extensions"):
--   pg_trgm        historical expression-index retirement and migration proofs
--   fuzzystrmatch  fuzzy and phonetic matching — levenshtein / dmetaphone / soundex
--   postgis        match(mode: within-distance) — ST_GeogFromText + ST_DWithin
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis;
