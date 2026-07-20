# @bankjobs/site

The BankJobs SA static site (Astro, `output: 'static'`). System fonts only, no
web fonts, no third-party requests, no JS on browse pages.

## Data dependency — run the ingest first

The site is built from JSON snapshots produced by the ingest pipeline. These
files are **gitignored** and do **not** exist in a fresh checkout:

- `src/data/jobs-full.json` — full open-job records (build-time SSG input, never shipped)
- `public/data/jobs.json` — lean client-fetchable rows (used by search)
- `public/data/meta.json` — freshness + counts (header, coverage)
- `public/data/category/{slug}.json` — per-category subsets

Generate them before the first `dev` / `build`:

```bash
pnpm ingest -- --source=absa     # live fetch, or:
pnpm ingest --fixtures           # offline, from committed fixtures
```

If they are missing, `src/lib/data.ts` fails to import with a clear
"Cannot find module '../data/jobs-full.json'" — run the ingest and retry.

> During standalone site development a realistic **sample** set may already be
> present (see the repo's data generator). The real `pnpm ingest` overwrites it.

## Commands

```bash
pnpm --filter @bankjobs/site run dev        # local dev server
pnpm --filter @bankjobs/site run build      # static build to dist/
pnpm --filter @bankjobs/site run preview    # preview the build
pnpm --filter @bankjobs/site run typecheck  # astro check
```

## Design notes

- One stylesheet: `src/styles/global.css` (imported by `src/layouts/Base.astro`).
- Palette: bg `#FAFAF8`, ink `#1B1F1D`, muted `#5A615D`, hairline `#E2E5E1`, accent `#0B6B4F`.
- Search is client-side only on `/search`; the data source + `PUBLIC_SEARCH_MODE`
  switch live in `src/lib/searchClient.ts` so a future Worker API is a one-file swap.
