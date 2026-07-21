-- Minimal sample data for `wrangler dev` local browsing. Applied AFTER
-- db/schema.sql (see the `db:local` package script). NOT used by tests — the
-- vitest suite seeds its own fixtures in test/seed.ts. INSERT triggers populate
-- jobs_fts automatically.

INSERT INTO jobs (
  id, source, brand, title, category, employment_type,
  description_html, description_text, excerpt,
  primary_location, raw_location, country, apply_url, posted_date,
  content_hash, status, first_seen, last_seen, missed_runs, closed_at, updated_at
) VALUES
  ('absa:R-1', 'absa', 'Absa', 'Branch Teller', 'Branch & Retail', 'Full time',
   '<p>Serve customers at our Johannesburg branch.</p>',
   'Serve customers at our Johannesburg branch handling deposits and withdrawals.',
   'Serve customers at our Johannesburg branch.',
   'Johannesburg, Gauteng', 'Johannesburg', 'ZA',
   'https://absa.wd3.myworkdayjobs.com/apply/R-1', '2026-07-05',
   'seed-1', 'open', '2026-07-05', '2026-07-05', 0, NULL, '2026-07-05'),
  ('absa:R-2', 'absa', 'Absa', 'Senior Backend Software Engineer', 'Software & IT', 'Full time',
   '<p>Build cloud backend services in Python and TypeScript.</p>',
   'Build cloud backend services in Python and TypeScript for our engineering platform.',
   'Build cloud backend services in Python.',
   'Cape Town, Western Cape', 'Cape Town', 'ZA',
   'https://absa.wd3.myworkdayjobs.com/apply/R-2', '2026-07-08',
   'seed-2', 'open', '2026-07-08', '2026-07-08', 0, NULL, '2026-07-08'),
  ('firstrand:R-100', 'firstrand', 'FNB', 'Data Analyst', 'Data & Analytics', 'Full time',
   '<p>Analyse customer data and build dashboards.</p>',
   'Analyse customer data and build dashboards using SQL and Python.',
   'Analyse customer data and build dashboards.',
   'Durban, KwaZulu-Natal', 'Durban', 'ZA',
   'https://firstrand.wd3.myworkdayjobs.com/apply/R-100', '2026-07-06',
   'seed-3', 'open', '2026-07-06', '2026-07-06', 0, NULL, '2026-07-06'),
  ('standardbank:R-200', 'standardbank', 'Standard Bank', 'Risk Manager', 'Risk & Compliance', 'Full time',
   '<p>Lead operational risk and compliance.</p>',
   'Lead operational risk and compliance across the corporate bank.',
   'Lead operational risk and compliance.',
   'Pretoria, Gauteng', 'Pretoria', 'ZA',
   'https://standardbank.example/apply/R-200', '2026-07-07',
   'seed-4', 'open', '2026-07-07', '2026-07-07', 0, NULL, '2026-07-07');

INSERT INTO job_locations (job_id, city, province) VALUES
  ('absa:R-1', 'Johannesburg', 'Gauteng'),
  ('absa:R-2', 'Cape Town', 'Western Cape'),
  ('firstrand:R-100', 'Durban', 'KwaZulu-Natal'),
  ('standardbank:R-200', 'Pretoria', 'Gauteng');

-- Update sources.last_success_at so /api/meta shows a timestamp locally.
UPDATE sources SET last_success_at = '2026-07-08T06:00:00.000Z'
 WHERE id IN ('absa', 'firstrand', 'standardbank');
