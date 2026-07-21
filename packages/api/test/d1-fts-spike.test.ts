import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './seed';

// PLAN GATE (§2.6 / §2.1): "spike FTS5 + triggers on real D1 first". These
// assertions run against a REAL workerd + D1 binding (via
// @cloudflare/vitest-pool-workers), proving the LOCAL/workerd path. The REMOTE
// D1 spike (scripts/spike-remote-d1.sql) is still REQUIRED before first deploy —
// see README. Schema DDL is applied once in beforeAll (tables persist across
// tests); each test's row writes are rolled back by isolated storage, so every
// case starts from an empty `jobs` table on top of the shared schema.

const T = '2026-07-01T00:00:00.000Z';

async function insertJob(id: string, title: string, descriptionText: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, source, brand, title, category, employment_type,
       description_html, description_text, excerpt,
       primary_location, raw_location, country, apply_url, posted_date,
       content_hash, status, first_seen, last_seen, missed_runs, closed_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,0,NULL,?)`,
  )
    .bind(
      id,
      'absa',
      'Absa',
      title,
      'Other',
      'Full time',
      `<p>${descriptionText}</p>`,
      descriptionText,
      descriptionText.slice(0, 40),
      null,
      null,
      'ZA',
      'https://absa.example/apply',
      null,
      `hash-${id}-${title}`,
      T,
      T,
      T,
    )
    .run();
}

async function matchIds(query: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT j.id AS id FROM jobs_fts
       JOIN jobs j ON j.rowid = jobs_fts.rowid
      WHERE jobs_fts MATCH ?
      ORDER BY bm25(jobs_fts), j.id`,
  )
    .bind(query)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe('D1 FTS5 + trigger spike (workerd/local)', () => {
  beforeAll(async () => {
    await applySchema(env.DB);
  });

  it('CREATE VIRTUAL TABLE fts5 and the three sync triggers exist', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, type FROM sqlite_master WHERE name IN ('jobs_fts','jobs_ai','jobs_ad','jobs_au') ORDER BY name",
    ).all<{ name: string; type: string }>();
    const byName = new Map(results.map((r) => [r.name, r.type]));
    expect(byName.get('jobs_fts')).toBe('table'); // fts5 virtual table
    expect(byName.get('jobs_ai')).toBe('trigger'); // AFTER INSERT
    expect(byName.get('jobs_ad')).toBe('trigger'); // AFTER DELETE
    expect(byName.get('jobs_au')).toBe('trigger'); // AFTER UPDATE OF title,description_text
  });

  it('INSERT trigger (jobs_ai) indexes new rows', async () => {
    await insertJob('absa:ins', 'Alpha Engineer', 'builds distributed systems');
    expect(await matchIds('engineer')).toEqual(['absa:ins']);
    expect(await matchIds('distributed')).toEqual(['absa:ins']); // body indexed too
  });

  it('scoped UPDATE trigger (jobs_au) reindexes when content columns change', async () => {
    await insertJob('absa:upd', 'Alpha Engineer', 'builds systems');
    expect(await matchIds('engineer')).toEqual(['absa:upd']);

    await env.DB.prepare(
      "UPDATE jobs SET title = 'Alpha Doctor', description_text = 'treats patients' WHERE id = ?",
    )
      .bind('absa:upd')
      .run();

    expect(await matchIds('engineer')).toEqual([]); // old terms gone
    expect(await matchIds('doctor')).toEqual(['absa:upd']); // new title indexed
    expect(await matchIds('patients')).toEqual(['absa:upd']); // new body indexed
  });

  it('lifecycle-only UPDATE does NOT churn the FTS index', async () => {
    await insertJob('absa:life', 'Alpha Engineer', 'builds systems');
    const before = await matchIds('engineer');
    expect(before).toEqual(['absa:life']);

    // Columns NOT in `AFTER UPDATE OF title, description_text` — the content
    // trigger structurally cannot fire, so the index is untouched.
    await env.DB.prepare(
      "UPDATE jobs SET last_seen = ?, missed_runs = 1, status = 'open' WHERE id = ?",
    )
      .bind('2026-07-02T00:00:00.000Z', 'absa:life')
      .run();

    expect(await matchIds('engineer')).toEqual(['absa:life']); // unchanged, no corruption
  });

  it('DELETE trigger (jobs_ad) removes rows from the index', async () => {
    await insertJob('absa:del', 'Alpha Engineer', 'builds systems');
    expect(await matchIds('engineer')).toEqual(['absa:del']);

    await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind('absa:del').run();
    expect(await matchIds('engineer')).toEqual([]);
  });

  it('MATCH + bm25 ranks a title hit above a body-only hit', async () => {
    await insertJob('absa:title', 'Software Engineer', 'general duties apply here');
    await insertJob('absa:body', 'Office Manager', 'works closely with an engineer daily');

    const ranked = await matchIds('engineer');
    expect(ranked).toEqual(['absa:title', 'absa:body']); // title hit first (lower bm25)
  });
});
