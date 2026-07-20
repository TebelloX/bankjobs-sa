import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_SLUGS, jobSlug } from '@bankjobs/core';
import type { Category, JobLocation, Province } from '@bankjobs/core';
import type { JobsDb } from './db';

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
 * Write the static data snapshots the site is built against. This is the ONLY
 * contract between ingest and site — field names are load-bearing.
 *
 *   {dir}/public/data/jobs.json           lean open-job list (client-fetchable)
 *   {dir}/public/data/meta.json           counts + source/category/province rollups
 *   {dir}/public/data/category/{slug}.json per-category lean lists (all 10 slugs)
 *   {dir}/src/data/jobs-full.json         full records incl. descriptionHtml (SSG input)
 */
export function emitSnapshots(db: JobsDb, snapshotDir: string, now: string): void {
  const jobs = db.all<JobRow>(
    `SELECT * FROM jobs WHERE status = 'open'
       ORDER BY (posted_date IS NULL), posted_date DESC, id`,
  );

  // First (primary) location per job, in insertion order, plus every location.
  const locRows = db.all<LocRow>(
    'SELECT job_id, city, province FROM job_locations ORDER BY job_id, rowid',
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

  const sources = db
    .all<{ id: string; name: string; last_success_at: string | null }>(
      'SELECT id, name, last_success_at FROM sources ORDER BY id',
    )
    .map((s) => ({
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
  const provinceRows = db.all<{ province: string; count: number }>(
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
}
