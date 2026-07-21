import type { CanonicalJob, SourceId } from '@bankjobs/core';
import type { JobsDb } from './db';
import { contentHash } from './hash';

export interface DiffResult {
  seen: number;
  inserted: number;
  updated: number;
  unchangedContent: number;
  closed: number;
}

interface LocationRow {
  city: string;
  province: string | null;
}

/**
 * At most this many ids per lifecycle-refresh statement. 80 ids + the single
 * `now` bind stays under D1's 100-bound-parameters-per-statement limit.
 */
const LIFECYCLE_CHUNK = 80;

/**
 * One row per location that carries a city or province. The table's primary key
 * is `(job_id, city)`, so we dedupe on city (using `''` when only a province is
 * known) and drop fully-unmatched entries — their raw string still survives on
 * the job's `primary_location` / `raw_location`.
 */
function locationRows(job: CanonicalJob): LocationRow[] {
  const byCity = new Map<string, LocationRow>();
  for (const loc of job.locations) {
    if (loc.city === null && loc.province === null) continue;
    const city = loc.city ?? '';
    if (!byCity.has(city)) byCity.set(city, { city, province: loc.province });
  }
  return [...byCity.values()];
}

async function insertLocations(db: JobsDb, jobId: string, job: CanonicalJob): Promise<void> {
  for (const row of locationRows(job)) {
    await db.run('INSERT INTO job_locations (job_id, city, province) VALUES (?, ?, ?)', [
      jobId,
      row.city,
      row.province,
    ]);
  }
}

/**
 * Insert new jobs and reconcile existing ones. Structured for the D1 REST API:
 * the whole source's stored hashes are preloaded in ONE query (per-job SELECTs
 * would blow Cloudflare's ~1200-request/5-min budget), and every re-seen job's
 * lifecycle refresh is folded into chunked `IN (...)` batches.
 *
 * For every seen job we always refresh lifecycle fields (`last_seen`,
 * `missed_runs`, `status`, `closed_at`) WITHOUT touching content columns, so
 * unchanged jobs never churn the FTS index nor bump `updated_at`. Only when the
 * content hash differs do we rewrite the content columns and refresh
 * `job_locations`. Reappearing closed jobs reopen; `first_seen` is preserved.
 */
export async function upsertJobs(
  db: JobsDb,
  source: SourceId,
  jobs: CanonicalJob[],
  now: string,
): Promise<Omit<DiffResult, 'closed'>> {
  // Dedupe within one feed keeping the FIRST occurrence, so a duplicate id can
  // neither slip past the preload map below nor double-insert.
  const deduped: CanonicalJob[] = [];
  const seenIds = new Set<string>();
  for (const job of jobs) {
    if (seenIds.has(job.id)) continue;
    seenIds.add(job.id);
    deduped.push(job);
  }

  const existingHash = new Map<string, string>();
  for (const row of await db.all<{ id: string; content_hash: string }>(
    'SELECT id, content_hash FROM jobs WHERE source = ?',
    [source],
  )) {
    existingHash.set(row.id, row.content_hash);
  }

  let inserted = 0;
  let updated = 0;
  let unchangedContent = 0;
  const reseenIds: string[] = [];

  for (const job of deduped) {
    const hash = contentHash(job);
    const rawLocation = job.locations[0]?.raw ?? null;
    const priorHash = existingHash.get(job.id);

    if (priorHash === undefined) {
      await db.run(
        `INSERT INTO jobs (
           id, source, brand, title, category, employment_type,
           description_html, description_text, excerpt,
           primary_location, raw_location, country, apply_url, posted_date,
           content_hash, status, first_seen, last_seen, missed_runs, closed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 0, NULL, ?)`,
        [
          job.id,
          source,
          job.brand,
          job.title,
          job.category,
          job.employmentType,
          job.descriptionHtml,
          job.descriptionText,
          job.excerpt,
          job.primaryLocation,
          rawLocation,
          job.country,
          job.applyUrl,
          job.postedDate,
          hash,
          now,
          now,
          now,
        ],
      );
      await insertLocations(db, job.id, job);
      inserted += 1;
      continue;
    }

    reseenIds.push(job.id);

    if (priorHash !== hash) {
      await db.run(
        `UPDATE jobs SET
           title = ?, category = ?, employment_type = ?,
           description_html = ?, description_text = ?, excerpt = ?,
           primary_location = ?, raw_location = ?, country = ?, apply_url = ?, posted_date = ?,
           content_hash = ?, updated_at = ?
         WHERE id = ?`,
        [
          job.title,
          job.category,
          job.employmentType,
          job.descriptionHtml,
          job.descriptionText,
          job.excerpt,
          job.primaryLocation,
          rawLocation,
          job.country,
          job.applyUrl,
          job.postedDate,
          hash,
          now,
          job.id,
        ],
      );
      await db.run('DELETE FROM job_locations WHERE job_id = ?', [job.id]);
      await insertLocations(db, job.id, job);
      updated += 1;
    } else {
      unchangedContent += 1;
    }
  }

  // Lifecycle refresh for every re-seen job in chunked `IN (...)` batches. This
  // statement never mentions title/description_text, so the FTS update trigger
  // (scoped to those columns) does not fire — keeping D1 row-writes low.
  for (let i = 0; i < reseenIds.length; i += LIFECYCLE_CHUNK) {
    const chunk = reseenIds.slice(i, i + LIFECYCLE_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    await db.run(
      `UPDATE jobs SET last_seen = ?, missed_runs = 0, status = 'open', closed_at = NULL
         WHERE id IN (${placeholders})`,
      [now, ...chunk],
    );
  }

  return { seen: deduped.length, inserted, updated, unchangedContent };
}

/**
 * Anti-flap closure. Any open job for this source not re-seen this run (its
 * `last_seen` predates `runStartedAt`) has its `missed_runs` bumped; jobs that
 * have now missed two consecutive runs are closed. Returns the number closed.
 */
export async function closeAbsentees(
  db: JobsDb,
  source: SourceId,
  runStartedAt: string,
  now: string,
): Promise<number> {
  await db.run(
    `UPDATE jobs SET missed_runs = missed_runs + 1
       WHERE source = ? AND status = 'open' AND last_seen < ?`,
    [source, runStartedAt],
  );
  const res = await db.run(
    `UPDATE jobs SET status = 'closed', closed_at = ?, updated_at = ?
       WHERE source = ? AND status = 'open' AND missed_runs >= 2`,
    [now, now, source],
  );
  return res.changes;
}
