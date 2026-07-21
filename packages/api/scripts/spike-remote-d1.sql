-- REMOTE D1 spike — the deploy-time gate the plan demands ("spike FTS5 +
-- triggers on real D1 first"). The vitest suite proves the LOCAL/workerd path;
-- this proves the SAME features on Cloudflare's managed D1, which historically
-- has restricted some SQLite features. RUN THIS ONCE, before the first deploy.
--
-- Prereqs: wrangler installed + `wrangler login` done, and a database created:
--   wrangler d1 create bankjobs        # copy the printed database_id into wrangler.jsonc
--
-- Then, from packages/api/:
--   wrangler d1 execute bankjobs --remote --file=../../db/schema.sql
--   wrangler d1 execute bankjobs --remote --file=./scripts/spike-remote-d1.sql
--
-- (Apply schema.sql first — it creates jobs / jobs_fts / the 3 triggers. If D1
-- REJECTS the FTS5 virtual table or the triggers at that step, that is the
-- documented fallback trigger — see README "Fallback".)
--
-- Each SELECT below is labelled and prints its own expected result. Compare the
-- wrangler output row-for-row.

-- Clean slate for the two spike rows (id-scoped; leaves any real data alone).
DELETE FROM jobs WHERE id IN ('spike:1', 'spike:2');

-- ── 1. INSERT trigger indexes new rows ──────────────────────────────────────
INSERT INTO jobs (
  id, source, brand, title, category, employment_type,
  description_html, description_text, excerpt,
  primary_location, raw_location, country, apply_url, posted_date,
  content_hash, status, first_seen, last_seen, missed_runs, closed_at, updated_at
) VALUES (
  'spike:1', 'absa', 'Absa', 'Alpha Engineer', 'Other', 'Full time',
  '<p>builds distributed systems</p>', 'builds distributed systems', 'builds distributed systems',
  NULL, NULL, 'ZA', 'https://absa.example/apply', NULL,
  'spike-hash-1', 'open', '2026-01-01', '2026-01-01', 0, NULL, '2026-01-01'
);
-- EXPECT: label=after_insert, id=spike:1  (INSERT trigger populated jobs_fts)
SELECT 'after_insert' AS label, j.id AS id
  FROM jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid
 WHERE jobs_fts MATCH 'engineer';

-- ── 2. bm25 ranking (title hit above body-only hit) ─────────────────────────
INSERT INTO jobs (
  id, source, brand, title, category, employment_type,
  description_html, description_text, excerpt,
  primary_location, raw_location, country, apply_url, posted_date,
  content_hash, status, first_seen, last_seen, missed_runs, closed_at, updated_at
) VALUES (
  'spike:2', 'absa', 'Absa', 'Office Manager', 'Other', 'Full time',
  '<p>works with an engineer daily</p>', 'works with an engineer daily', 'works with an engineer daily',
  NULL, NULL, 'ZA', 'https://absa.example/apply', NULL,
  'spike-hash-2', 'open', '2026-01-01', '2026-01-01', 0, NULL, '2026-01-01'
);
-- EXPECT: two rows, spike:1 (title match) BEFORE spike:2 (body match).
SELECT 'bm25' AS label, j.id AS id, bm25(jobs_fts) AS rank
  FROM jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid
 WHERE jobs_fts MATCH 'engineer'
 ORDER BY bm25(jobs_fts), j.id;

-- ── 3. Scoped UPDATE trigger reindexes on content change ────────────────────
UPDATE jobs SET title = 'Alpha Doctor', description_text = 'treats patients'
 WHERE id = 'spike:1';
-- EXPECT: zero rows (old term 'engineer' gone from spike:1's index entry).
SELECT 'after_update_old_term' AS label, j.id AS id
  FROM jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid
 WHERE jobs_fts MATCH 'engineer' AND j.id = 'spike:1';
-- EXPECT: id=spike:1 (new term 'doctor' now indexed).
SELECT 'after_update_new_term' AS label, j.id AS id
  FROM jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid
 WHERE jobs_fts MATCH 'doctor';

-- ── 4. Lifecycle-only UPDATE does NOT churn the FTS index ────────────────────
-- Columns NOT in `AFTER UPDATE OF title, description_text` — trigger cannot fire.
UPDATE jobs SET last_seen = '2026-01-02', missed_runs = 1, status = 'open'
 WHERE id = 'spike:2';
-- EXPECT: id=spike:2 still matches its unchanged body term (index intact).
SELECT 'after_lifecycle_update' AS label, j.id AS id
  FROM jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid
 WHERE jobs_fts MATCH 'engineer';

-- ── 5. DELETE trigger removes rows from the index ───────────────────────────
DELETE FROM jobs WHERE id = 'spike:2';
-- EXPECT: zero rows (DELETE trigger removed spike:2 from jobs_fts).
SELECT 'after_delete' AS label, j.id AS id
  FROM jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid
 WHERE jobs_fts MATCH 'engineer';

-- Cleanup.
DELETE FROM jobs WHERE id IN ('spike:1', 'spike:2');
-- EXPECT: label=cleanup, n=0
SELECT 'cleanup' AS label, COUNT(*) AS n FROM jobs WHERE id IN ('spike:1', 'spike:2');
