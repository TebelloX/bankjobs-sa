# @bankjobs/api — Cloudflare Worker read API

Read-only, open-jobs-only search API over the D1 `jobs` database (plan §2.6). Built and
**locally proven against real workerd + D1**; the **remote D1 spike is REQUIRED before the first
deploy** (see below).

## Endpoints

All responses are JSON with `Access-Control-Allow-Origin: *`. Every query filters `status = 'open'`
— closed/hidden rows and ingestion internals are never exposed.

- `GET /api/jobs` — query params:
  - `q` — full-text search over title + description (FTS5 MATCH, bm25 ordering). Sanitized: user
    input can never reach MATCH raw (operators/quotes/`*` are neutralized); empty-after-sanitize
    falls back to an unfiltered listing.
  - `category` — the category **name** (`Software & IT`) **or** its slug (`software-it`).
  - `province`, `city` — normalized location filters (a job matches if any of its locations match).
  - `source` — source id (`absa`, `firstrand`, …).
  - `country` — ISO alpha-2 (`country=ZA` selects SA); default: no country filter.
  - `limit` (default 20, hard cap 50), `offset` (default 0, cap 10000).
  - Returns `{ total, limit, offset, jobs: [...] }`. Row fields mirror the snapshot lean row
    (`site/src/lib/searchClient.ts` `SearchRow`) plus `excerpt` + `applyUrl`.
- `GET /api/jobs/:id` — full record incl. `descriptionHtml`. Accepts the canonical id (`absa:R-1`)
  or its URL slug (`absa-r-1`). 404 JSON for unknown/non-open.
- `GET /api/meta` — totals, per-source counts + `lastSuccessAt`, SA-only category/province rollups.
  Mirrors ingest's `meta.json` (`packages/ingest/src/snapshots.ts`).
- Anything else → 404 JSON `{ error }`. Non-GET → 405 (`Allow: GET`).

## Free-tier discipline

- **Edge cache** (`caches.default`) keyed on a normalized request URL (known params only, sorted;
  unknown params dropped). `Cache-Control: public, max-age=300, s-maxage=900` — browse/search data
  changes only 3×/day, so most traffic never touches D1 (5M reads/day free limit). Only 200s are
  cached; cache HITs are served **before** the rate limiter spends a token.
- **Per-IP rate limit** — in-memory token bucket (60 req/min, burst 20), keyed on
  `CF-Connecting-IP`, `429` + `Retry-After` when exceeded. Per-isolate and resets on eviction (an
  honest, "simple" free-tier guard, not a global limiter).
- **Sessions API** — reads go through `env.DB.withSession('first-unconstrained')` for
  nearest-replica reads (`src/db.ts`). miniflare supports `withSession`, so tests exercise it; the
  code falls back to the bare binding if a runtime lacks it.

## Scripts

```sh
pnpm --filter @bankjobs/api run test        # vitest on the workers pool (real workerd + D1)
pnpm --filter @bankjobs/api run typecheck   # tsc --noEmit
pnpm --filter @bankjobs/api run db:local    # apply schema + seed to LOCAL D1 (for dev)
pnpm --filter @bankjobs/api run dev          # wrangler dev (local D1)
```

Root `pnpm test` runs the node-pool packages **and** this workers-pool suite.

Local dev flow:

```sh
cd packages/api
pnpm run db:local     # wrangler d1 execute DB --local --file=../../db/schema.sql (+ seed-local.sql)
pnpm run dev          # → http://localhost:8788
curl 'http://localhost:8788/api/jobs?q=engineer'
```

## D1 FTS5 spike — status

The plan gates the API on "spike FTS5 + triggers on real D1 first" because D1 restricts some SQLite
features.

### Proven locally (workerd + D1, `test/d1-fts-spike.test.ts`)

Against a real D1 binding via `@cloudflare/vitest-pool-workers`, applying `db/schema.sql` verbatim:

- `CREATE VIRTUAL TABLE ... USING fts5(...)` (external content) + the 3 sync triggers all create.
- INSERT trigger (`jobs_ai`) indexes new rows.
- Scoped UPDATE trigger (`jobs_au`, `AFTER UPDATE OF title, description_text`) reindexes on content
  change; a lifecycle-only UPDATE (status/missed_runs/last_seen) does **not** churn the index.
- DELETE trigger (`jobs_ad`) removes rows.
- `MATCH` + `bm25()` rank correctly (title hit above body-only hit).

`wrangler dev` with local D1 additionally smoke-tested clean: list, `q=`, category+province,
`/api/jobs/:id`, `/api/meta`, hostile-`q`, 404, 405, and cache MISS→HIT with key normalization.

### Remote spike — PASSED 21 Jul 2026 ✅

Run against the real `bankjobs` database (WEUR, id `1ed5662e-2fab-402b-96d1-bac8175a52a6`,
now wired into `wrangler.jsonc`): schema.sql applied cleanly (fts5 virtual table + all three
triggers accepted), and the spike below matched its expected table **row-for-row** (replayed
statement-by-statement via `--command`, since a multi-statement `--file` on remote D1 reports
only aggregate stats — worth knowing for future remote debugging). Managed D1 fully supports
our FTS setup; the ingest-maintains-the-index fallback is NOT needed.

### The spike (for reference / re-runs)

The local runtime is workerd; **managed D1 is not proven until you run the remote spike.** Once
`wrangler login` is done and the DB exists:

```sh
wrangler d1 create bankjobs                 # copy database_id into wrangler.jsonc
cd packages/api
wrangler d1 execute bankjobs --remote --file=../../db/schema.sql
wrangler d1 execute bankjobs --remote --file=./scripts/spike-remote-d1.sql
```

`scripts/spike-remote-d1.sql` prints one labelled result per behavior. Expected:

| label                    | expected                                     |
| ------------------------ | -------------------------------------------- |
| `after_insert`           | `spike:1`                                    |
| `bm25`                   | `spike:1` then `spike:2` (title before body) |
| `after_update_old_term`  | (no rows)                                    |
| `after_update_new_term`  | `spike:1`                                    |
| `after_lifecycle_update` | `spike:2`                                    |
| `after_delete`           | (no rows)                                    |
| `cleanup`                | `n = 0`                                      |

### Fallback if remote D1 rejects FTS5 / triggers

If the `schema.sql` step errors on `CREATE VIRTUAL TABLE` or the triggers on **remote** D1 (it does
not locally), the documented fallback is: **ingest maintains `jobs_fts` explicitly** instead of via
triggers — do the `INSERT/DELETE INTO jobs_fts(...)` writes inside `upsertJobs`/`closeAbsentees` in
`packages/ingest/src/diff.ts` (right where the jobs-table writes already happen), and drop the three
`CREATE TRIGGER` statements from `db/schema.sql`. This API's read queries are unaffected (they only
read `jobs_fts` via MATCH). **Not built now** — only needed if the remote spike fails.

## Deploy-time checklist

1. `wrangler d1 create bankjobs` → paste `database_id` into `wrangler.jsonc`.
2. `wrangler d1 execute bankjobs --remote --file=../../db/schema.sql`.
3. Run the remote spike above; confirm the table matches (or take the fallback).
4. Decide route / custom domain (unset in `wrangler.jsonc`).
5. `wrangler deploy`. Ingestion (GitHub Actions) writes the real rows.
