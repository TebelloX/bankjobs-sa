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
| `packages/api`      | Cloudflare Worker read API (deferred)                                                        |
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

To exercise the remote path locally:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_D1_DATABASE_ID=...
pnpm ingest -- --remote --dry-run
```

## Operating principles

- **Official sources only, link out, never host.** Trust is the entire product.
- **A failed run never closes jobs.** Closure requires absence from two consecutive successful
  runs of a source; anomaly guardrails (zero jobs, >50% count drop) skip closure and fail loudly.
- **Fixtures from day one.** Every adapter is built and tested against committed real responses;
  `fixtures/*/manifest.json` records when and where they were captured.
- **Light on data.** ≤150 KB first browse view, no web fonts, no third-party requests.
