# BankJobs SA

A free, ad-free aggregator of official job listings from South African banks. Every listing
links out to the bank's own application page — this site never hosts applications, accounts,
or CVs.

Product docs live in [`docs/`](docs/) (PRD + implementation plan).

## Layout

| Path                | What it is                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core`     | Canonical `Job` type, HTML sanitizer, location normalizer, category classifier               |
| `packages/adapters` | Per-source adapters (shared Workday client; Absa live)                                       |
| `packages/ingest`   | Ingestion orchestrator: fetch → normalize → diff → upsert → snapshots                        |
| `packages/api`      | Cloudflare Worker read API (`bankjobs-api`), FTS5 search on D1                               |
| `site`              | Astro static site                                                                            |
| `db`                | SQLite/D1 schema + migrations                                                                |
| `fixtures`          | Committed real API responses per source — adapter tests run against these, never the network |

## Development

Requires Node ≥ 24 and pnpm.

```sh
pnpm install
pnpm ingest -- --source=absa   # fetch live jobs into db/local.db + emit site data snapshots
pnpm dev                       # Astro dev server (needs the ingest snapshots to exist)
pnpm test                      # unit + fixture tests (no network)
pnpm typecheck
```

Useful ingest flags: `--dry-run` (print summary, write nothing), `--fixtures` (run the committed
fixtures through the full pipeline — works offline), `--db=<path>`, `--snapshot-dir=<path>`.

## Scheduled ingestion & D1

[`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) runs every enabled source against
the production Cloudflare D1 database three times a day (06:00/12:00/18:00 SAST). Each bank gets
its own step, isolated with `continue-on-error`, so one source's outage never stops the rest —
the run still goes red afterwards so it doesn't pass unnoticed. Upserts are keyed on a content
hash, so an unchanged job costs a skip rather than a write; that keeps D1 row-writes far below
the 100k/day free-tier limit even at three runs a day.

One-time setup:

1. Make the repo public — scheduled workflows only get free Actions minutes on public repos
   (or fund private-runner minutes if it must stay private).
2. Create a Cloudflare API token with `D1:Edit` permission scoped to this account.
3. `gh secret set CLOUDFLARE_API_TOKEN`
4. Verify the wiring with a manual dispatch (`dry_run: true`) before letting the cron write. The
   dispatch's `only` input runs a single source, handy for a first check.

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_D1_DATABASE_ID` are committed directly in the workflow —
they're identifiers, not credentials.

GitHub's schedule trigger is best-effort and occasionally drops a slot outright. The
`bankjobs-cron` Cloudflare Worker in [`packages/cron`](packages/cron) covers exactly that gap:
it fires 18 minutes after each ingest slot, checks the GitHub API for a run created in the last
25 minutes, and dispatches `ingest.yml` via `workflow_dispatch` if the slot never fired. It
needs a `GITHUB_TOKEN` Worker secret (`wrangler secret put GITHUB_TOKEN` from `packages/cron`;
a fine-grained PAT with Actions read/write on this repo is enough). It deliberately does not
retry runs that started and failed — red runs are a human's signal.

To exercise the remote path locally:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_D1_DATABASE_ID=...
pnpm ingest -- --remote --dry-run
```

## Production topology & deploys

- **API** — the Cloudflare Worker in `packages/api` (`bankjobs-api`) serves `/api/*` off the
  production D1 database, on its free `workers.dev` URL.
- **Site** — the Astro site builds to Cloudflare Pages project `bankjobs-sa`, also on its free
  `pages.dev` domain. It rebuilds three times a day right after each scheduled ingest run
  (`ingest.yml`'s `publish-site` job, `needs: ingest` + `if: !cancelled()` — it runs even when a
  source failed that cycle, because D1 always holds the best data available and one bank's
  outage must never stop the rest of the site from refreshing) and again on every push to `main`
  (`deploy.yml`'s `site` job), so code changes go live immediately rather than waiting for the
  next cron tick. Both paths regenerate `site/public/data/*.json` and `site/src/data/jobs-full.json`
  straight from prod via `pnpm ingest -- --snapshot-only --remote` before building — the site
  never ships stale or fixture data.
- **Search** — static browse pages always read the pre-built JSON snapshots. The search box calls
  the Worker instead only when the build was given `PUBLIC_SEARCH_MODE=api` and
  `PUBLIC_API_BASE=<worker url>`; both are sourced from the repository variable
  `vars.PUBLIC_API_BASE`, and the build falls back to static-search mode (omitting both) whenever
  that variable is empty — see the one-time setup below for when it gets set.
- **Worker deploys** — [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)'s `worker`
  job deploys `packages/api` on `workflow_dispatch` with `worker: true`, or automatically on push
  to `main` when `packages/api/**` or `db/schema.sql` changed (a `git diff` against the pre-push
  commit stands in for a per-job paths filter — no third-party action needed).

One-time deploy setup, additional to the scheduled-ingestion steps above:

1. Widen the existing `CLOUDFLARE_API_TOKEN` in the Cloudflare dashboard to also grant
   **Workers Scripts:Edit** and **Cloudflare Pages:Edit** (keep `D1:Edit`). Until this is done,
   both deploy jobs fail with an auth error — ingest.yml is unaffected, since it only ever
   touches D1.
2. Create the Pages project once, for reference (also happens implicitly on first
   `wrangler pages deploy` if it doesn't exist yet):
   ```sh
   wrangler pages project create bankjobs-sa --production-branch=main
   ```
3. Trigger a Worker deploy (`workflow_dispatch` on `deploy.yml` with `worker: true`), note the
   `*.workers.dev` URL it prints, then point the site's search at it:
   ```sh
   gh variable set PUBLIC_API_BASE --body "https://<actual-worker-subdomain>.workers.dev"
   ```
   The next site build (scheduled or on push) picks it up automatically.

`pages.dev` / `workers.dev` free domains are the deliberate launch setup per the
[implementation plan](docs/BankJobs-SA-Implementation-Plan.md) §2.8 — a custom domain is a
Phase 4 decision, not a launch blocker.

## Operating principles

- **Official sources only, link out, never host.** Trust is the entire product.
- **A failed run never closes jobs.** Closure requires absence from two consecutive successful
  runs of a source; anomaly guardrails (zero jobs, >50% count drop) skip closure and fail loudly.
- **Fixtures from day one.** Every adapter is built and tested against committed real responses;
  `fixtures/*/manifest.json` records when and where they were captured.
- **Light on data.** ≤150 KB first browse view, no web fonts, no third-party requests.
