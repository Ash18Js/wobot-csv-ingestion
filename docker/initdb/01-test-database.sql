-- Runs once, the first time the postgres volume is created.
--
-- The test suite truncates tables between cases, so it gets a database of its
-- own. Reviewers can run `docker compose run --rm test` at any time without
-- losing whatever they have just ingested into the real one.
CREATE DATABASE catalog_test OWNER catalog;
