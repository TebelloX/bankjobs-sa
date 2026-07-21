import { CATEGORY_SLUGS, SOURCES, jobSlug } from '@bankjobs/core/job';
import type { Category } from '@bankjobs/core/job';
import type { Env } from './types';
import { detectBrand, resolveBrandParam } from './brands';
import { type Reader, reader } from './db';
import { sanitizeFtsQuery } from './fts';
import { errorJson, json } from './http';

// --- category resolution: accept the canonical name OR its slug -------------
const SLUG_TO_CATEGORY = new Map<string, Category>();
for (const [name, slug] of Object.entries(CATEGORY_SLUGS)) {
  SLUG_TO_CATEGORY.set(slug, name as Category);
}
const CATEGORY_NAMES = new Set<string>(Object.keys(CATEGORY_SLUGS));
const CATEGORY_SLUG_SET = new Set(Object.values(CATEGORY_SLUGS));

function resolveCategory(param: string): string | null {
  const trimmed = param.trim();
  const bySlug = SLUG_TO_CATEGORY.get(trimmed.toLowerCase());
  if (bySlug !== undefined) return bySlug;
  if (CATEGORY_NAMES.has(trimmed)) return trimmed;
  return null;
}

// Mirror snapshots.ts: unknown category name falls back to 'other'.
function categorySlugFor(category: string): string {
  return CATEGORY_SLUGS[category as Category] ?? 'other';
}

// --- GET /api/jobs ----------------------------------------------------------
const LIST_COLS = `
  j.id AS id, j.title AS title, j.brand AS brand, j.source AS source,
  j.category AS category, j.primary_location AS primaryLocation,
  j.country AS country, j.excerpt AS excerpt, j.posted_date AS postedDate,
  j.apply_url AS applyUrl,
  (SELECT jl.city FROM job_locations jl WHERE jl.job_id = j.id ORDER BY jl.rowid LIMIT 1) AS city,
  (SELECT jl.province FROM job_locations jl WHERE jl.job_id = j.id ORDER BY jl.rowid LIMIT 1) AS province`;

interface RawListRow {
  id: string;
  title: string;
  brand: string;
  source: string;
  category: string;
  primaryLocation: string | null;
  country: string;
  excerpt: string;
  postedDate: string | null;
  applyUrl: string;
  city: string | null;
  province: string | null;
}

function parseLimit(v: string | null): number {
  if (v === null || v.trim() === '') return 20; // Number(null)/Number('') are 0, not NaN
  const n = Number(v);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

function parseOffset(v: string | null): number {
  if (v === null || v.trim() === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10_000, Math.floor(n));
}

// Field names + order mirror the snapshot lean rows (searchClient.SearchRow),
// plus excerpt/applyUrl the API adds for search results.
function shapeListRow(r: RawListRow): unknown {
  return {
    id: r.id,
    slug: jobSlug(r.id),
    title: r.title,
    brand: r.brand,
    source: r.source,
    category: r.category,
    categorySlug: categorySlugFor(r.category),
    city: r.city === '' ? null : r.city,
    province: r.province,
    primaryLocation: r.primaryLocation,
    country: r.country,
    excerpt: r.excerpt,
    postedDate: r.postedDate,
    applyUrl: r.applyUrl,
  };
}

export async function handleJobsList(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const limit = parseLimit(p.get('limit'));
  const offset = parseOffset(p.get('offset'));

  const categoryParam = p.get('category');
  let categoryName: string | null = null;
  if (categoryParam !== null && categoryParam !== '') {
    categoryName = resolveCategory(categoryParam);
    // A category that does not exist means zero matches, not "ignore filter".
    if (categoryName === null) return json({ total: 0, limit, offset, jobs: [] });
  }

  // Bank-name interpretation: a q like "Standard Bank" constrains j.brand (the
  // old client-side behavior) instead of leaking every description that mentions
  // standard+bank. Only the leftover words drive FTS; an alias with no remainder
  // falls through to the plain listing path (match === '') with the brand clause.
  const qRaw = p.get('q') ?? '';
  const detected = detectBrand(qRaw);
  const match = sanitizeFtsQuery(detected ? detected.remainder : qRaw);

  const clauses = ["j.status = 'open'"];
  const binds: unknown[] = [];
  let from = 'jobs j';
  let order = '(j.posted_date IS NULL), j.posted_date DESC, j.id';

  if (match !== '') {
    // External-content FTS5: jobs_fts.rowid maps to jobs.rowid.
    from = 'jobs_fts JOIN jobs j ON j.rowid = jobs_fts.rowid';
    clauses.push('jobs_fts MATCH ?');
    binds.push(match);
    order = 'bm25(jobs_fts), j.id';
  }

  // Brand constraint from the detected bank name in q and/or the explicit
  // `brand` param (case-insensitive; an unknown value binds as-is and matches
  // nothing, like `source`). Both compose as AND; identical values collapse.
  const brands = new Set<string>();
  if (detected) brands.add(detected.brand);
  const brandParam = p.get('brand');
  if (brandParam) brands.add(resolveBrandParam(brandParam));
  for (const b of brands) {
    clauses.push('j.brand = ?');
    binds.push(b);
  }

  if (categoryName !== null) {
    clauses.push('j.category = ?');
    binds.push(categoryName);
  }
  const country = p.get('country');
  if (country) {
    clauses.push('j.country = ?');
    binds.push(country.toUpperCase());
  }
  const source = p.get('source');
  if (source) {
    clauses.push('j.source = ?');
    binds.push(source.toLowerCase());
  }
  const province = p.get('province');
  if (province) {
    clauses.push(
      'EXISTS (SELECT 1 FROM job_locations jl WHERE jl.job_id = j.id AND jl.province = ?)',
    );
    binds.push(province);
  }
  const city = p.get('city');
  if (city) {
    clauses.push('EXISTS (SELECT 1 FROM job_locations jl WHERE jl.job_id = j.id AND jl.city = ?)');
    binds.push(city);
  }

  // Count + page as ONE batch (single D1 round trip). Kept as two statements
  // because FTS5's bm25() may not share a query with COUNT(*) OVER().
  const whereSql = clauses.join(' AND ');
  const read = reader(env);
  const countStmt = read
    .prepare(`SELECT COUNT(*) AS c FROM ${from} WHERE ${whereSql}`)
    .bind(...binds);
  const pageStmt = read
    .prepare(
      `SELECT ${LIST_COLS} FROM ${from} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset);

  const batch = await read.batch<Record<string, unknown>>([countStmt, pageStmt]);
  const total = Number((batch[0]?.results[0]?.['c'] as number | undefined) ?? 0);
  const rows = (batch[1]?.results ?? []) as unknown as RawListRow[];
  return json({ total, limit, offset, jobs: rows.map(shapeListRow) });
}

// --- GET /api/jobs/:id ------------------------------------------------------
const DETAIL_COLS = `
  id, source, brand, title, category,
  employment_type AS employmentType,
  description_html AS descriptionHtml, description_text AS descriptionText,
  excerpt, primary_location AS primaryLocation, raw_location AS rawLocation,
  country, apply_url AS applyUrl, posted_date AS postedDate`;

interface RawDetailRow {
  id: string;
  source: string;
  brand: string;
  title: string;
  category: string;
  employmentType: string | null;
  descriptionHtml: string;
  descriptionText: string;
  excerpt: string;
  primaryLocation: string | null;
  rawLocation: string | null;
  country: string;
  applyUrl: string;
  postedDate: string | null;
}

/**
 * Accept either the canonical id (`absa:R-1`) or its URL slug (`absa-r-1`).
 * Ids always contain ':'; a slug never does. Slugging is lossy so it can't be
 * reversed in SQL — but the slug always starts with `<source>-`, so we scan only
 * that source's open ids (indexed, ~tens of rows) and compare jobSlug().
 */
async function resolveJobId(read: Reader, param: string): Promise<string | null> {
  if (param.includes(':')) {
    const row = await read
      .prepare("SELECT id FROM jobs WHERE id = ? AND status = 'open'")
      .bind(param)
      .first<{ id: string }>();
    return row?.id ?? null;
  }
  const slug = param.toLowerCase();
  const source = SOURCES.find((s) => slug === s || slug.startsWith(`${s}-`));
  const stmt = source
    ? read.prepare("SELECT id FROM jobs WHERE source = ? AND status = 'open'").bind(source)
    : read.prepare("SELECT id FROM jobs WHERE status = 'open'");
  const { results } = await stmt.all<{ id: string }>();
  for (const r of results) {
    if (jobSlug(r.id) === slug) return r.id;
  }
  return null;
}

export async function handleJobDetail(idOrSlug: string, env: Env): Promise<Response> {
  const read = reader(env);
  const id = await resolveJobId(read, idOrSlug);
  if (id === null) return errorJson(404, 'job not found');

  const row = await read
    .prepare(`SELECT ${DETAIL_COLS} FROM jobs WHERE id = ? AND status = 'open'`)
    .bind(id)
    .first<RawDetailRow>();
  if (row === null) return errorJson(404, 'job not found');

  const locs = await read
    .prepare('SELECT city, province FROM job_locations WHERE job_id = ? ORDER BY rowid')
    .bind(id)
    .all<{ city: string | null; province: string | null }>();

  const rawFallback = row.rawLocation ?? row.primaryLocation ?? '';
  const locations = locs.results.map((l) => ({
    city: l.city === '' ? null : l.city,
    province: l.province,
    raw: rawFallback,
  }));

  return json({
    id: row.id,
    slug: jobSlug(row.id),
    source: row.source,
    brand: row.brand,
    title: row.title,
    category: row.category,
    categorySlug: categorySlugFor(row.category),
    employmentType: row.employmentType,
    descriptionHtml: row.descriptionHtml,
    descriptionText: row.descriptionText,
    excerpt: row.excerpt,
    primaryLocation: row.primaryLocation,
    locations,
    country: row.country,
    applyUrl: row.applyUrl,
    postedDate: row.postedDate,
  });
}

// --- GET /api/meta ----------------------------------------------------------
interface SourceMetaRow {
  id: string;
  name: string;
  lastSuccessAt: string | null;
  count: number;
}

// Aggregates mirror ingest's snapshot meta.json (packages/ingest/src/snapshots.ts):
// source counts span all open jobs; category/province counts are SA-only.
export async function handleMeta(env: Env): Promise<Response> {
  const read = reader(env);
  const res = await read.batch([
    read.prepare(
      `SELECT COUNT(*) AS totalOpen,
              SUM(CASE WHEN country = 'ZA' THEN 1 ELSE 0 END) AS totalSA
         FROM jobs WHERE status = 'open'`,
    ),
    read.prepare(
      `SELECT s.id AS id, s.name AS name, s.last_success_at AS lastSuccessAt,
              (SELECT COUNT(*) FROM jobs j WHERE j.source = s.id AND j.status = 'open') AS count
         FROM sources s ORDER BY s.id`,
    ),
    read.prepare(
      `SELECT category AS category, COUNT(*) AS count
         FROM jobs WHERE status = 'open' AND country = 'ZA' GROUP BY category`,
    ),
    read.prepare(
      `SELECT jl.province AS province, COUNT(DISTINCT j.id) AS count
         FROM job_locations jl JOIN jobs j ON j.id = jl.job_id
         WHERE j.status = 'open' AND j.country = 'ZA' AND jl.province IS NOT NULL
         GROUP BY jl.province`,
    ),
  ]);

  const totalsRow = (res[0]?.results[0] ?? {}) as { totalOpen?: number; totalSA?: number | null };
  const totalOpen = Number(totalsRow.totalOpen ?? 0);
  const totalSA = Number(totalsRow.totalSA ?? 0);

  const sources = ((res[1]?.results ?? []) as SourceMetaRow[]).map((s) => ({
    id: s.id,
    name: s.name,
    count: Number(s.count),
    lastSuccessAt: s.lastSuccessAt,
  }));

  const categories: Record<string, number> = {};
  for (const slug of CATEGORY_SLUG_SET) categories[slug] = 0;
  for (const c of (res[2]?.results ?? []) as { category: string; count: number }[]) {
    const slug = categorySlugFor(c.category);
    categories[slug] = (categories[slug] ?? 0) + Number(c.count);
  }

  const provinces: Record<string, number> = {};
  for (const p of (res[3]?.results ?? []) as { province: string; count: number }[]) {
    const count = Number(p.count);
    if (count > 0) provinces[p.province] = count;
  }

  return json({
    generatedAt: new Date().toISOString(),
    totalOpen,
    totalSA,
    totalInternational: totalOpen - totalSA,
    sources,
    categories,
    provinces,
  });
}
