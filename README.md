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

## Operating principles

- **Official sources only, link out, never host.** Trust is the entire product.
- **A failed run never closes jobs.** Closure requires absence from two consecutive successful
  runs of a source; anomaly guardrails (zero jobs, >50% count drop) skip closure and fail loudly.
- **Fixtures from day one.** Every adapter is built and tested against committed real responses;
  `fixtures/*/manifest.json` records when and where they were captured.
- **Light on data.** ≤150 KB first browse view, no web fonts, no third-party requests.
