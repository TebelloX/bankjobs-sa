import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_SLUGS, jobSlug } from '@bankjobs/core';
import type { Category, JobLocation, Province } from '@bankjobs/core';
import type { JobsDb } from './db';
import { emitInsights } from './insights';

interface JobRow {
  id: string;
  source: string;
  brand: string;
  title: string;
  category: string;
  employment_type: string | null;
  description_html: string;
  description_text: string;
  excerpt: string;
  primary_location: string | null;
  raw_location: string | null;
  country: string;
  apply_url: string;
  posted_date: string | null;
  status: string;
  first_seen: string;
  last_seen: string;
  missed_runs: number;
  closed_at: string | null;
  updated_at: string;
}

interface LocRow {
  job_id: string;
  city: string | null;
  province: string | null;
}

function categorySlugFor(category: string): string {
  return CATEGORY_SLUGS[category as Category] ?? 'other';
}

/**
 * Rows per page when reading the two unbounded tables. Over the D1 REST API the
 * entire result set comes back in one JSON response, and each `jobs` row carries
 * tens of KB of `description_html` (the ~556 open rows total several MB) — a
 * single unbounded SELECT overflows D1's response-size ceiling. We page by rowid
 * instead (a keyset cursor on the output ORDER BY is fiddly; rowid is monotonic
 * and unique) and re-sort/group in JS so every file stays byte-identical to the
 * old single-query output. `job_locations` rows are tiny, hence the larger page.
 * Exported so the chunking test can't silently drift from these values.
 */
export const SNAPSHOT_JOB_CHUNK = 200;
export const SNAPSHOT_LOCATION_CHUNK = 2000;

/**
 * Read an entire table in rowid-ordered pages, following the last row's rowid as
 * the cursor. `sql` must select a `rowid` column, filter on `rowid > ?`, and end
 * with a literal `LIMIT chunkSize`.
 */
async function readAllByRowid<T extends { rowid: number }>(
  db: JobsDb,
  sql: string,
  chunkSize: number,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor = 0;
  for (;;) {
    const page = await db.all<T>(sql, [cursor]);
    rows.push(...page);
    if (page.length < chunkSize) break;
    cursor = page[page.length - 1]!.rowid;
  }
  return rows;
}

/**
 * The exact order the single-query version produced in SQL:
 *   ORDER BY (posted_date IS NULL), posted_date DESC, id
 * Reapplied in JS after the rowid-paged read so jobs.json / the category files /
 * jobs-full.json come out byte-identical. `id` is the primary key (unique), so
 * this is a total order.
 */
function compareOutputOrder(a: JobRow, b: JobRow): number {
  const aNull = a.posted_date === null ? 1 : 0;
  const bNull = b.posted_date === null ? 1 : 0;
  if (aNull !== bNull) return aNull - bNull;
  if (a.posted_date !== b.posted_date) {
    return (a.posted_date ?? '') < (b.posted_date ?? '') ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Write the static data snapshots the site is built against. This is the ONLY
 * contract between ingest and site — field names are load-bearing.
 *
 *   {dir}/public/data/jobs.json           lean open-job list (client-fetchable)
 *   {dir}/public/data/meta.json           counts + source/category/province rollups
 *   {dir}/public/data/category/{slug}.json per-category lean lists (all 10 slugs)
 *   {dir}/src/data/jobs-full.json         full records incl. descriptionHtml (SSG input)
 *   {dir}/src/data/insights.json          history aggregates for /insights/ (SSG input)
 */
export async function emitSnapshots(db: JobsDb, snapshotDir: string, now: string): Promise<void> {
  // Read the open jobs in rowid-ordered pages (see readAllByRowid / the chunk
  // constants): the full description_html makes one unbounded SELECT overflow
  // the D1 REST response. Sorting happens in JS so the output stays byte-for-
  // byte identical to the old single-query form.
  const jobs = (
    await readAllByRowid<JobRow & { rowid: number }>(
      db,
      `SELECT *, rowid FROM jobs WHERE status = 'open' AND rowid > ?
         ORDER BY rowid LIMIT ${SNAPSHOT_JOB_CHUNK}`,
      SNAPSHOT_JOB_CHUNK,
    )
  ).sort(compareOutputOrder);

  // First (primary) location per job, in insertion order, plus every location.
  // Also paged by rowid (this table is unbounded too); the per-job grouping
  // below is insensitive to how jobs interleave, so global rowid order yields
  // the same firstLoc/allLocs as the old `ORDER BY job_id, rowid`.
  const locRows = await readAllByRowid<LocRow & { rowid: number }>(
    db,
    `SELECT job_id, city, province, rowid FROM job_locations WHERE rowid > ?
       ORDER BY rowid LIMIT ${SNAPSHOT_LOCATION_CHUNK}`,
    SNAPSHOT_LOCATION_CHUNK,
  );
  const firstLoc = new Map<string, { city: string | null; province: string | null }>();
  const allLocs = new Map<string, { city: string | null; province: string | null }[]>();
  for (const l of locRows) {
    const city = l.city === '' ? null : l.city;
    if (!firstLoc.has(l.job_id)) firstLoc.set(l.job_id, { city, province: l.province });
    const arr = allLocs.get(l.job_id) ?? [];
    arr.push({ city, province: l.province });
    allLocs.set(l.job_id, arr);
  }

  const slugs = new Set(Object.values(CATEGORY_SLUGS));

  const publicDataDir = join(snapshotDir, 'public', 'data');
  const categoryDir = join(publicDataDir, 'category');
  const srcDataDir = join(snapshotDir, 'src', 'data');
  mkdirSync(categoryDir, { recursive: true });
  mkdirSync(srcDataDir, { recursive: true });

  // --- lean rows: jobs.json + category files ------------------------------
  const leanRows = jobs.map((j) => {
    const loc = firstLoc.get(j.id);
    return {
      id: j.id,
      slug: jobSlug(j.id),
      title: j.title,
      brand: j.brand,
      source: j.source,
      category: j.category,
      categorySlug: categorySlugFor(j.category),
      city: loc?.city ?? null,
      province: loc?.province ?? null,
      primaryLocation: j.primary_location,
      country: j.country,
      postedDate: j.posted_date,
    };
  });
  writeFileSync(join(publicDataDir, 'jobs.json'), JSON.stringify(leanRows));

  for (const slug of slugs) {
    const rows = leanRows.filter((r) => r.categorySlug === slug);
    writeFileSync(join(categoryDir, `${slug}.json`), JSON.stringify(rows));
  }

  // --- meta.json ----------------------------------------------------------
  const totalOpen = jobs.length;
  const totalSA = jobs.filter((j) => j.country === 'ZA').length;
  const totalInternational = totalOpen - totalSA;

  const openBySource = new Map<string, number>();
  for (const j of jobs) openBySource.set(j.source, (openBySource.get(j.source) ?? 0) + 1);

  const sources = (
    await db.all<{ id: string; name: string; last_success_at: string | null }>(
      'SELECT id, name, last_success_at FROM sources ORDER BY id',
    )
  ).map((s) => ({
    id: s.id,
    name: s.name,
    count: openBySource.get(s.id) ?? 0,
    lastSuccessAt: s.last_success_at,
  }));

  const categories: Record<string, number> = {};
  for (const slug of slugs) categories[slug] = 0;
  for (const j of jobs) {
    if (j.country !== 'ZA') continue;
    const slug = categorySlugFor(j.category);
    categories[slug] = (categories[slug] ?? 0) + 1;
  }

  const provinces: Record<string, number> = {};
  const provinceRows = await db.all<{ province: string; count: number }>(
    `SELECT jl.province AS province, COUNT(DISTINCT j.id) AS count
       FROM job_locations jl JOIN jobs j ON j.id = jl.job_id
       WHERE j.status = 'open' AND j.country = 'ZA' AND jl.province IS NOT NULL
       GROUP BY jl.province`,
  );
  for (const p of provinceRows) if (p.count > 0) provinces[p.province] = p.count;

  const meta = {
    generatedAt: now,
    totalOpen,
    totalSA,
    totalInternational,
    sources,
    categories,
    provinces,
  };
  writeFileSync(join(publicDataDir, 'meta.json'), JSON.stringify(meta));

  // --- jobs-full.json (SSG input) -----------------------------------------
  const seenSlugs = new Set<string>();
  const full = jobs.map((j) => {
    const slug = jobSlug(j.id);
    if (seenSlugs.has(slug)) throw new Error(`duplicate slug '${slug}' (job ${j.id})`);
    seenSlugs.add(slug);

    const rawFallback = j.raw_location ?? j.primary_location ?? '';
    const locations: JobLocation[] = (allLocs.get(j.id) ?? []).map((l) => ({
      city: l.city,
      province: l.province as Province | null,
      raw: rawFallback,
    }));

    return {
      id: j.id,
      source: j.source,
      brand: j.brand,
      title: j.title,
      category: j.category,
      employmentType: j.employment_type,
      descriptionHtml: j.description_html,
      descriptionText: j.description_text,
      excerpt: j.excerpt,
      primaryLocation: j.primary_location,
      locations,
      country: j.country,
      applyUrl: j.apply_url,
      postedDate: j.posted_date,
      status: j.status,
      firstSeen: j.first_seen,
      lastSeen: j.last_seen,
      missedRuns: j.missed_runs,
      closedAt: j.closed_at,
      updatedAt: j.updated_at,
      slug,
      categorySlug: categorySlugFor(j.category),
    };
  });
  writeFileSync(join(srcDataDir, 'jobs-full.json'), JSON.stringify(full));

  // --- insights.json (SSG input) ------------------------------------------
  // Last, and from here rather than from the CLI, so every path that emits
  // snapshots emits this too: local ingest, --fixtures and --snapshot-only
  // --remote alike.
  await emitInsights(db, snapshotDir, now);
}
