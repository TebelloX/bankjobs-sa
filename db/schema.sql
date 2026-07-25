-- BankJobs SA — canonical schema.
-- Must run identically on local SQLite (node:sqlite / sqlite3 CLI) and Cloudflare D1.

PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_success_at TEXT
);

INSERT INTO sources (id, name, enabled) VALUES
  ('absa', 'Absa', 1),
  ('firstrand', 'FirstRand', 1),
  ('standardbank', 'Standard Bank', 1),
  ('investec', 'Investec', 1),
  -- Adapter ready, but the GoTyme Workable feed is empty at build time. Seeded
  -- disabled so scheduled runs skip it (a 0-job source trips the guardrail on
  -- every run); flip enabled to 1 when GoTyme posts roles.
  ('gotyme', 'GoTyme Bank', 0),
  ('nedbank', 'Nedbank', 1),
  -- Discovery's careers site is group-wide; we keep only Business Unit =
  -- 'Discovery Bank', which is a handful of roles. Enabled, but note the low
  -- count: it can legitimately hit 0 and trip the zero-jobs guardrail (warn +
  -- skip closures — safe by design; do NOT weaken the guardrail for it).
  ('discovery', 'Discovery Bank', 1),
  -- Capitec's careers site is single-brand (every posting is Capitec) on the
  -- same SuccessFactors CSB sitemap path as Discovery; ~50 roles, no filter.
  ('capitec', 'Capitec', 1),
  -- The SA Reserve Bank on Oracle Recruiting Cloud (Fusion HCM CE); a single
  -- Pretoria site, ~24 roles. Enabled.
  ('sarb', 'SARB', 1);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL REFERENCES sources(id),
  brand            TEXT NOT NULL,
  title            TEXT NOT NULL,
  category         TEXT NOT NULL,
  employment_type  TEXT,
  description_html TEXT NOT NULL,
  description_text TEXT NOT NULL,
  excerpt          TEXT NOT NULL,
  primary_location TEXT,
  raw_location     TEXT,
  country          TEXT NOT NULL DEFAULT 'ZA',
  apply_url        TEXT NOT NULL,
  posted_date      TEXT,
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'hidden')),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  missed_runs      INTEGER NOT NULL DEFAULT 0,
  closed_at        TEXT,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_jobs_source_status ON jobs(source, status);
CREATE INDEX idx_jobs_status_category ON jobs(status, category);
CREATE INDEX idx_jobs_posted ON jobs(posted_date DESC);
CREATE INDEX idx_jobs_country_status ON jobs(country, status);

CREATE TABLE job_locations (
  job_id   TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  city     TEXT,
  province TEXT,
  PRIMARY KEY (job_id, city)
);

CREATE INDEX idx_job_locations_province ON job_locations(province);

-- External-content FTS5 over title + plain-text description.
-- description_text exists so FTS never indexes HTML tags.
CREATE VIRTUAL TABLE jobs_fts USING fts5(
  title,
  description_text,
  content='jobs',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- The UPDATE trigger is scoped to content columns so lifecycle-only updates
-- (last_seen, missed_runs, status) never churn the FTS index — this also keeps
-- D1 row-writes low once ingestion runs remotely.
CREATE TRIGGER jobs_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, description_text)
  VALUES (new.rowid, new.title, new.description_text);
END;

CREATE TRIGGER jobs_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, description_text)
  VALUES ('delete', old.rowid, old.title, old.description_text);
END;

CREATE TRIGGER jobs_au AFTER UPDATE OF title, description_text ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, description_text)
  VALUES ('delete', old.rowid, old.title, old.description_text);
  INSERT INTO jobs_fts(rowid, title, description_text)
  VALUES (new.rowid, new.title, new.description_text);
END;

CREATE TABLE ingestion_runs (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT NOT NULL DEFAULT 'running'
              CHECK (outcome IN ('running', 'success', 'warning', 'failure')),
  jobs_seen   INTEGER,
  jobs_new    INTEGER,
  jobs_closed INTEGER,
  warning     TEXT
);

-- The two push tables below already exist in the prod D1: they were added there
-- on 25 Jul 2026 by a separate idempotent (IF NOT EXISTS) migration, not by this
-- file. This file stays fresh-database truth and is never re-run against a live
-- database, so bare CREATE TABLE — same treatment as every table above.

-- Web-push subscriptions. One row per browser subscription: the push-service
-- endpoint URL plus the two client keys needed to encrypt payloads for it.
-- Deliberately NOTHING else — no user id, no email, no user agent. endpoint is
-- the natural primary key (each subscription's URL is unique) and the only
-- handle a subscriber needs to delete themselves.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Single-row state for the push sender (packages/ingest): the first_seen
-- watermark that makes digest sends idempotent across re-runs.
CREATE TABLE push_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
