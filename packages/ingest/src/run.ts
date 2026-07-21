import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalJob, SourceId } from '@bankjobs/core';
import type {
  EarcuRawPosting,
  SfRawPosting,
  SfSitemapPosting,
  SrListResponse,
  SrPostingDetail,
  SrRawPosting,
  WorkableJobDetail,
  WorkableListResponse,
  WorkableRawPosting,
  WorkdayJobDetail,
  WorkdayListResponse,
  WorkdayRawPosting,
} from '@bankjobs/adapters';
import {
  extractCanonicalUrl,
  extractDatePosted,
  extractJobId,
  extractJobPostingLd,
  extractSfCanonicalUrl,
  parseFeed,
  parseSitemapDetail,
} from '@bankjobs/adapters';
import { openIngestDb, repoRoot } from './db';
import type { JobsDb } from './db';
import { registry } from './registry';
import { checkAnomaly } from './guardrails';
import { closeAbsentees, upsertJobs } from './diff';
import { emitSnapshots } from './snapshots';

export interface RunOptions {
  sources: SourceId[];
  dryRun: boolean;
  fixtures: boolean;
  dbPath: string;
  snapshotDir: string;
  log: (msg: string) => void;
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const FAILURE_RATIO = 0.1;

type Outcome = 'success' | 'warning' | 'failure';

const FIXTURE_DETAIL_RE = /^detail-.*\.json$/;
const FIXTURE_DETAIL_HTML_RE = /^detail-.*\.html$/;
const FIXTURE_STANDIN_DETAIL_RE = /^standin-detail-.*\.json$/;

function fixtureDetailFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => FIXTURE_DETAIL_RE.test(f))
    .sort();
}

/**
 * Workday fixtures (absa, firstrand): pair each captured detail with the list
 * item whose bulletFields contain its jobReqId. `normalize` only reads the
 * detail (plus the list item's bulletFields for firstrand's sub-brand), so a
 * missing list item is synthesised.
 */
function loadWorkdayFixtures(source: SourceId): WorkdayRawPosting[] {
  const dir = join(repoRoot(), 'fixtures', source);
  const list = JSON.parse(
    readFileSync(join(dir, 'list-page1.json'), 'utf8'),
  ) as WorkdayListResponse;

  const pairs: WorkdayRawPosting[] = [];
  for (const file of fixtureDetailFiles(dir)) {
    const detail = JSON.parse(readFileSync(join(dir, file), 'utf8')) as WorkdayJobDetail;
    const reqId = detail.jobPostingInfo.jobReqId;
    const listItem = list.jobPostings.find((p) => p.bulletFields.includes(reqId)) ?? {
      title: detail.jobPostingInfo.title,
      externalPath: '',
      bulletFields: [reqId, detail.jobPostingInfo.startDate],
    };
    pairs.push({ listItem, detail });
  }
  return pairs;
}

/**
 * SmartRecruiters fixtures (standardbank): pair each captured detail with its
 * list item by id. The detail is a superset of the list posting, so it doubles
 * as its own fallback list item when the list page doesn't carry the id.
 */
function loadSrFixtures(): SrRawPosting[] {
  const dir = join(repoRoot(), 'fixtures', 'standardbank');
  const list = JSON.parse(readFileSync(join(dir, 'list-page1.json'), 'utf8')) as SrListResponse;

  const pairs: SrRawPosting[] = [];
  for (const file of fixtureDetailFiles(dir)) {
    const detail = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SrPostingDetail;
    const listItem = list.content.find((p) => p.id === detail.id) ?? detail;
    pairs.push({ listItem, detail });
  }
  return pairs;
}

/**
 * eArcu fixtures (investec): each detail-*.html is a full captured detail page.
 * The parsed JobPosting JSON-LD is the raw payload and the page's own canonical
 * link is the durable apply URL — the same two extractions the live client runs.
 */
function loadEarcuFixtures(): EarcuRawPosting[] {
  const dir = join(repoRoot(), 'fixtures', 'investec');
  const files = readdirSync(dir)
    .filter((f) => FIXTURE_DETAIL_HTML_RE.test(f))
    .sort();

  const raws: EarcuRawPosting[] = [];
  for (const file of files) {
    const html = readFileSync(join(dir, file), 'utf8');
    const jsonLd = extractJobPostingLd(html);
    const url = extractCanonicalUrl(html);
    if (jsonLd === null || url === null) continue;
    raws.push({ url, jsonLd });
  }
  return raws;
}

/**
 * Workable fixtures (gotyme): the real GoTyme feed is empty, so the offline
 * fixtures are a stand-in employer captured to pin the populated schema. Pair
 * each standin-detail with its standin-list item by shortcode (the detail is a
 * superset, so it doubles as its own fallback list item).
 */
function loadWorkableFixtures(): WorkableRawPosting[] {
  const dir = join(repoRoot(), 'fixtures', 'gotyme');
  const list = JSON.parse(
    readFileSync(join(dir, 'standin-list.json'), 'utf8'),
  ) as WorkableListResponse;
  const files = readdirSync(dir)
    .filter((f) => FIXTURE_STANDIN_DETAIL_RE.test(f))
    .sort();

  const pairs: WorkableRawPosting[] = [];
  for (const file of files) {
    const detail = JSON.parse(readFileSync(join(dir, file), 'utf8')) as WorkableJobDetail;
    const listItem = list.results.find((p) => p.shortcode === detail.shortcode) ?? detail;
    pairs.push({ listItem, detail });
  }
  return pairs;
}

/**
 * SuccessFactors fixtures (nedbank): parse the committed feed.xml into items —
 * the feed is the single load-bearing source. The few committed detail-*.html
 * pages enrich postedDate for the items they cover (matched by numeric job id);
 * every other item carries postedDate null, exactly as a live run does whenever
 * the non-fatal detail enrichment misses.
 */
function loadSuccessFactorsFixtures(): SfRawPosting[] {
  const dir = join(repoRoot(), 'fixtures', 'nedbank');
  const items = parseFeed(readFileSync(join(dir, 'feed.xml'), 'utf8'));

  const postedById = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => FIXTURE_DETAIL_HTML_RE.test(f))) {
    const html = readFileSync(join(dir, file), 'utf8');
    const url = extractSfCanonicalUrl(html);
    const id = url ? extractJobId(url) : null;
    const posted = extractDatePosted(html);
    if (id && posted) postedById.set(id, posted);
  }

  return items.map((item) => ({ item, postedDate: postedById.get(item.id) ?? null }));
}

/**
 * SuccessFactors SITEMAP fixtures (discovery): each detail-*.html is a full
 * captured detail page — the load-bearing source on the sitemap path. Parse
 * each into a structured posting (its own canonical link supplies the URL), then
 * apply the SAME Discovery-Bank filter the live `fetchAll` does, so the offline
 * pipeline drops the committed non-bank fixture(s) exactly as production would.
 */
function loadDiscoveryFixtures(): SfSitemapPosting[] {
  const dir = join(repoRoot(), 'fixtures', 'discovery');
  const postings: SfSitemapPosting[] = [];
  for (const file of readdirSync(dir).filter((f) => FIXTURE_DETAIL_HTML_RE.test(f))) {
    const html = readFileSync(join(dir, file), 'utf8');
    const url = extractSfCanonicalUrl(html);
    if (url === null) continue;
    const posting = parseSitemapDetail(html, url);
    if (posting === null) continue;
    postings.push(posting);
  }
  return postings.filter((p) => p.businessUnit.trim() === 'Discovery Bank');
}

/** Build raw postings from committed fixtures (offline dev + CI). */
function loadFixtures(source: SourceId): unknown[] {
  if (source === 'standardbank') return loadSrFixtures();
  if (source === 'investec') return loadEarcuFixtures();
  if (source === 'gotyme') return loadWorkableFixtures();
  if (source === 'nedbank') return loadSuccessFactorsFixtures();
  if (source === 'discovery') return loadDiscoveryFixtures();
  return loadWorkdayFixtures(source);
}

function finalizeRun(
  db: JobsDb,
  runId: number,
  outcome: Outcome,
  jobsSeen: number,
  jobsNew: number,
  jobsClosed: number,
  warning: string | null,
  finishedAt: string,
): void {
  db.run(
    `UPDATE ingestion_runs
       SET finished_at = ?, outcome = ?, jobs_seen = ?, jobs_new = ?, jobs_closed = ?, warning = ?
       WHERE run_id = ?`,
    [finishedAt, outcome, jobsSeen, jobsNew, jobsClosed, warning, runId],
  );
}

/** Tally raw strings that resolved to no city and no province, with counts. */
function collectUnmatched(jobs: CanonicalJob[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const job of jobs) {
    for (const loc of job.locations) {
      if (loc.city === null && loc.province === null) {
        m.set(loc.raw, (m.get(loc.raw) ?? 0) + 1);
      }
    }
  }
  return m;
}

function logUnmatched(log: (msg: string) => void, unmatched: Map<string, number>): void {
  if (unmatched.size === 0) {
    log('  unmatched locations: none');
    return;
  }
  const total = [...unmatched.values()].reduce((a, b) => a + b, 0);
  log(`  unmatched locations (${unmatched.size} distinct, ${total} occurrences):`);
  const sorted = [...unmatched.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [raw, count] of sorted) log(`    ${raw} (${count})`);
}

/**
 * Run ingestion for the given sources, sequentially and isolated (one source
 * throwing never stops the others). Returns the intended process exit code:
 * 1 if any source failed or warned, else 0.
 */
export async function runIngest(opts: RunOptions): Promise<number> {
  const { sources, dryRun, fixtures, dbPath, snapshotDir, log } = opts;
  const db = openIngestDb(dbPath, dryRun);

  let failed = false;
  let warned = false;
  const summaries: string[] = [];

  try {
    for (const source of sources) {
      const runStartedAt = new Date().toISOString();
      let runId: number | undefined;

      try {
        const adapter = registry[source];
        if (!adapter) throw new Error(`no adapter registered for source '${source}'`);

        if (!dryRun) {
          db.run(
            "INSERT INTO ingestion_runs (source, started_at, outcome) VALUES (?, ?, 'running')",
            [source, runStartedAt],
          );
          const row = db.get<{ id: number }>('SELECT last_insert_rowid() AS id');
          runId = Number(row?.id);
        }

        log(`[${source}] ${dryRun ? 'dry-run ' : ''}${fixtures ? '(fixtures) ' : ''}starting…`);

        const raws = fixtures
          ? loadFixtures(source)
          : await adapter.fetchAll({ log: (m) => log(`  ${m}`) });

        const jobs: CanonicalJob[] = [];
        let failures = 0;
        for (const raw of raws) {
          try {
            jobs.push(adapter.normalize(raw));
          } catch (e) {
            failures += 1;
            log(`  [skip] normalize failed: ${(e as Error).message}`);
          }
        }

        const total = raws.length;
        const failureRatio = total === 0 ? 0 : failures / total;
        if (failureRatio > FAILURE_RATIO) {
          const warning = `normalize failure ratio ${(failureRatio * 100).toFixed(1)}% (${failures}/${total}) exceeds ${FAILURE_RATIO * 100}% — source aborted, no mutations`;
          log(`[${source}] FAILURE: ${warning}`);
          if (!dryRun && runId !== undefined) {
            finalizeRun(db, runId, 'failure', jobs.length, 0, 0, warning, new Date().toISOString());
          }
          failed = true;
          summaries.push(`${source}: FAILURE (${warning})`);
          continue;
        }

        const seen = jobs.length;
        const baseline = db.get<{ jobs_seen: number | null }>(
          "SELECT jobs_seen FROM ingestion_runs WHERE source = ? AND outcome = 'success' ORDER BY run_id DESC LIMIT 1",
          [source],
        );
        const lastSuccessSeen = baseline?.jobs_seen ?? null;
        const guard = checkAnomaly(seen, lastSuccessSeen);
        const unmatched = collectUnmatched(jobs);

        if (dryRun) {
          const existingIds = new Set(
            db
              .all<{ id: string }>('SELECT id FROM jobs WHERE source = ?', [source])
              .map((r) => r.id),
          );
          const wouldInsert = jobs.filter((j) => !existingIds.has(j.id)).length;
          const seenIds = new Set(jobs.map((j) => j.id));
          const openIds = db
            .all<{ id: string }>("SELECT id FROM jobs WHERE source = ? AND status = 'open'", [
              source,
            ])
            .map((r) => r.id);
          const wouldClose = openIds.filter((id) => !seenIds.has(id)).length;

          log(`[${source}] dry-run summary:`);
          log(`  seen:               ${seen}`);
          log(`  would-insert:       ${wouldInsert} (not already in DB)`);
          log(`  already in DB:      ${seen - wouldInsert}`);
          log(`  would-close cands.: ${wouldClose} (open, absent this run)`);
          log(`  guardrail:          ${guard.ok ? 'OK' : `TRIPPED — ${guard.reason}`}`);
          logUnmatched(log, unmatched);

          if (!guard.ok) warned = true;
          summaries.push(
            `${source}: dry-run seen=${seen} wouldInsert=${wouldInsert} wouldClose=${wouldClose} guardrail=${guard.ok ? 'ok' : 'tripped'}`,
          );
          continue;
        }

        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        let closed = 0;
        db.transaction(() => {
          const r = upsertJobs(db, source, jobs, runStartedAt);
          inserted = r.inserted;
          updated = r.updated;
          unchanged = r.unchangedContent;
          if (guard.ok) {
            closed = closeAbsentees(db, source, runStartedAt, runStartedAt);
          } else {
            log(
              `[${source}] ⚠ GUARDRAIL TRIPPED — ${guard.reason}. Upserts applied; CLOSURE SKIPPED.`,
            );
          }
        });

        const outcome: Outcome = guard.ok ? 'success' : 'warning';
        const warning = guard.ok ? null : (guard.reason ?? null);
        if (runId !== undefined) {
          finalizeRun(
            db,
            runId,
            outcome,
            seen,
            inserted,
            closed,
            warning,
            new Date().toISOString(),
          );
        }
        if (outcome === 'success') {
          db.run('UPDATE sources SET last_success_at = ? WHERE id = ?', [runStartedAt, source]);
        } else {
          warned = true;
        }

        log(
          `[${source}] ${outcome}: seen=${seen} new=${inserted} changed=${updated} unchanged=${unchanged} closed=${closed}`,
        );
        logUnmatched(log, unmatched);
        summaries.push(
          `${source}: ${outcome} seen=${seen} new=${inserted} changed=${updated} closed=${closed}`,
        );
      } catch (e) {
        const msg = (e as Error).message;
        log(`[${source}] ERROR: ${msg}`);
        if (!dryRun && runId !== undefined) {
          finalizeRun(db, runId, 'failure', 0, 0, 0, msg, new Date().toISOString());
        }
        failed = true;
        summaries.push(`${source}: FAILURE (${msg})`);
      }
    }

    if (!dryRun) {
      const nowFinal = new Date().toISOString();
      const cutoff = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();
      const hidden = db.run(
        "UPDATE jobs SET status = 'hidden', updated_at = ? WHERE status = 'open' AND last_seen < ?",
        [nowFinal, cutoff],
      );
      if (hidden.changes > 0) {
        log(`staleness backstop: hid ${hidden.changes} job(s) not seen in 60 days`);
      }
      emitSnapshots(db, snapshotDir, nowFinal);
      log(`snapshots written to ${snapshotDir}`);
    }

    log('');
    log('=== ingest summary ===');
    for (const s of summaries) log(s);
  } finally {
    db.close();
  }

  return failed || warned ? 1 : 0;
}
