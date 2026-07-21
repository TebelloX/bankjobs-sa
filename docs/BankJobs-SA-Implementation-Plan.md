# BankJobs SA — Implementation Plan

**Version:** 0.4 · **Date:** 21 July 2026 · **Companion to:** BankJobs SA PRD v0.2

This plan translates the PRD into a build sequence. It is written for a solo developer working in evenings/weekends; effort estimates are rough and assume familiarity with TypeScript. Each phase ends with a working, deployable system — never a half-built one.

---

## 0. Guiding rules for the build

1. **Data first, UI last.** The website is the easy 10%. Every phase orders work so data acquisition risk is retired earliest.
2. **Vertical slices.** Get one bank flowing end-to-end (fetch → normalize → store → render) before adding the second. Integration problems surface at the seams, not in the parts.
3. **Everything runs locally first.** The ingestion pipeline must run against local SQLite with `npm run ingest` before any Cloudflare wiring. D1 is SQLite, so the local/prod gap is tiny — keep it that way.
4. **Fixtures from day one.** Every adapter is built against a saved sample of the real API/HTML response, committed to the repo. This is what makes CI meaningful when feeds change.

---

## 1. Repository & project structure

Single monorepo, public (required for free GitHub Actions).

```
bankjobs-sa/
├── packages/
│   ├── core/              # canonical Job type, taxonomy rules, location normalizer, diff logic
│   ├── adapters/          # one module per source
│   │   ├── workday/       # shared Workday client (Absa + FirstRand configs)
│   │   ├── smartrecruiters/
│   │   ├── oracle/        # SARB (Phase 3)
│   │   ├── successfactors/# Nedbank (Phase 3)
│   │   └── capitec/       # scraper (Phase 3)
│   ├── ingest/            # orchestrator: run adapters, diff, upsert, snapshot, guardrails
│   └── api/               # Cloudflare Worker (search API)
├── site/                  # Astro frontend
├── db/
│   ├── schema.sql         # D1 schema + FTS5 + triggers
│   └── migrations/
├── fixtures/              # committed sample responses per source
└── .github/workflows/
    ├── ingest.yml         # scheduled scrape
    ├── ci.yml             # tests on PR
    └── deploy.yml         # site + worker deploy
```

**Tooling:** pnpm workspaces, TypeScript strict, Vitest, Wrangler CLI, Prettier. No framework in `ingest` — plain Node scripts keep GitHub Actions runs simple to debug.

---

## 2. Phase 1 — MVP (three clean-feed banks, end to end)

**Goal:** Absa + FirstRand + Standard Bank live on a deployed site, ingestion running on a schedule, closure policy working.
**Rough effort:** 4–6 weekends.

### 2.1 Canonical model & schema (first, everything depends on it)

- [ ] Define `Job` type in `core`: `id` (`source:reqId`), `source`, `brand`, `title`, `category`, `employmentType`, `descriptionHtml` (sanitized), `excerpt`, `primaryLocation`, `locations[]`, `applyUrl`, `postedDate`.
- [ ] Lifecycle fields: `status` (`open | closed | hidden`), `firstSeen`, `lastSeen`, `missedRuns`, `closedAt`, `updatedAt`.
- [ ] Write `db/schema.sql`:
  - `jobs` (PK = canonical id)
  - `job_locations` (job_id, city, province) — normalized filtering
  - `jobs_fts` — FTS5 over title + description, synced by triggers on `jobs`
  - `sources` (id, name, enabled, last_success_at)
  - `ingestion_runs` (run_id, source, started_at, outcome, jobs_seen, jobs_new, jobs_closed, warning)
- [ ] Verify the schema runs identically on local SQLite and `wrangler d1`.

**Definition of done:** `sqlite3 test.db < schema.sql` succeeds; inserting a job and querying FTS works.

### 2.2 Core utilities

- [ ] **HTML sanitizer** — allowlist (p, ul/ol/li, h3–h4, strong, em, a→stripped or rel-nofollowed). Strip scripts, styles, tracking pixels. Generate `excerpt` (~300–400 chars, sentence-boundary truncation).
- [ ] **Location normalizer** — map free-text ATS locations to `{city, province}` via a hand-rolled lookup table (start with ~60 SA cities/towns; log unmatched values to fix iteratively). Keep raw string as fallback.
- [ ] **Category classifier** — ordered keyword rules over title (+ source category field where present) → one of ~10 categories, fallthrough `Other`. Rules in versioned JSON per source.
- [ ] **Apply-URL cleaner** — strip known tracking params; verify link still resolves in tests.
- [ ] Unit tests for all four against fixture data.

### 2.3 Adapters (the risk core — do these before any UI)

Order: **Absa → FirstRand → Standard Bank.**

Per adapter:
- [ ] Re-verify the endpoint in the browser network inspector (PRD §7 warns endpoints drift).
- [ ] Save 2–3 real responses into `fixtures/<source>/`.
- [ ] Implement `fetchAll(): Promise<RawPosting[]>` with pagination, polite delays, honest User-Agent.
- [ ] Implement `normalize(raw): Job` mapping into the canonical shape.
- [ ] Fixture test: `normalize(fixture)` snapshot-matches expected canonical output.
- [ ] FirstRand only: map Workday tenant sub-brand → `brand` (FNB / RMB / WesBank / Ashburton / DirectAxis).

**Definition of done per adapter:** `npm run ingest -- --source=absa --dry-run` prints N normalized jobs locally.

### 2.4 Ingestion orchestrator

- [ ] Run enabled adapters sequentially; **isolate failures** (try/catch per source, continue).
- [ ] Diff against DB per source:
  - new id → insert, `firstSeen = now`
  - existing id → update `lastSeen`, reset `missedRuns`, update changed fields
  - absent id → increment `missedRuns`; close when `missedRuns >= 2` **and the run succeeded**
- [ ] **Anomaly guardrails:** if a source returns 0 jobs, or count dropped >50% vs its last successful run → record warning in `ingestion_runs`, **skip the closure step for that source**, exit non-zero for that step.
- [ ] 60-day staleness backstop: `status = hidden` for anything not re-confirmed.
- [ ] Emit static snapshots: `/data/jobs.json`, `/data/category/{slug}.json`, `/data/meta.json` (counts + per-source last-updated).
- [ ] Write to D1 remotely via `wrangler d1 execute` (batched) or the D1 HTTP API — decide during build; batching writes matters for the 100k rows/day free limit.

**Definition of done:** two consecutive local runs against live feeds produce a stable DB with sensible new/closed counts; killing one adapter mid-run doesn't affect the others.

### 2.5 GitHub Actions wiring

- [ ] `ingest.yml`: cron 3×/day (e.g. 06:00, 12:00, 18:00 SAST), manual dispatch enabled. Secrets: Cloudflare API token, account/DB ids.
- [ ] Per-source steps so one failure emails you but others complete (Actions notifies on failure by default — confirm notification settings).
- [ ] `ci.yml`: typecheck + unit/fixture tests on PR.

### 2.6 Read API (Worker)

- [ ] `GET /api/jobs` — filters: `q` (FTS), `category`, `location`, `source`, pagination. Reads D1 via Sessions API (nearest replica).
- [ ] `GET /api/jobs/:id`, `GET /api/meta`.
- [ ] Edge caching: Cache API keyed on normalized query string; TTL ~15 min (data changes 3×/day, so this is safe).
- [ ] Simple per-IP rate limit (e.g. token bucket in cache) to protect free-tier quota.

### 2.7 Astro frontend

- [ ] Pages: home/browse (reads static `/data/*.json`), search results (calls Worker), job detail, about/legal page (unaffiliated disclaimer + takedown contact).
- [ ] Job detail: title, bank, location, posted date, excerpt, **prominent "Apply on [Bank]'s official site" button**, `JobPosting` JSON-LD (`directApply: false`, `validThrough` = lastSeen + closure window).
- [ ] "Last updated" indicator from `meta.json`.
- [ ] Page-weight budget: ≤150 KB first browse view. No client framework on browse pages — Astro islands only for the search box.
- [ ] Semantic HTML, keyboard navigation, WCAG 2.1 AA basics.
- [ ] Sitemap (job detail URLs + browse pages), robots.txt.

### 2.8 Deploy & validate

- [ ] Cloudflare Pages project (site) + Worker (api) + D1 (prod DB). Free `pages.dev` domain is fine at launch.
- [ ] Smoke test: full pipeline from Actions → D1 → site within one scheduled cycle.
- [ ] Submit sitemap to Google Search Console; verify JobPosting markup with the Rich Results test.
- [ ] Recruit ~20 real job seekers; run the **validation gate** (PRD §4): ≥10 would use it again over checking bank portals directly.

**Phase 1 exit criteria:** validation gate passed; freshness <12h holding; zero manual interventions needed for a full week of scheduled runs.

---

## 3. Phase 2 — Scale reads & SEO

**Goal:** discoverability and durability. **Effort:** 2–3 weekends.

- [ ] Category and location landing pages (e.g. `/jobs/software-development/gauteng`) — statically generated, the main SEO surface.
- [ ] Search Console monitoring; fix any structured-data warnings.
- [ ] Harden caching: verify browse path never touches the Worker; measure D1 read counts against the 5M/day limit.
- [ ] Monitoring polish: a tiny `/status` page rendering `ingestion_runs` (per-source last success, counts, warnings).
- [ ] Iterate the taxonomy and location tables using real unmatched-value logs.
- [ ] Zombie-rate spot check: sample 30 listings, click through, confirm still open; tune closure window if >5% stale.

**Exit criteria:** organic impressions trending up 4 consecutive weeks; freshness target met 4 weeks; guardrails have caught at least one real anomaly or been fire-drilled.

---

## 4. Phase 3 — Broaden (harder sources)

**Goal:** SARB, Nedbank, then Capitec — the mission milestone. **Effort:** 4–8 weekends (Capitec is the unknown).

- [ ] **SARB (Oracle Cloud Recruiting REST):** same adapter pattern; expect fiddlier pagination/auth-less quirks. Fixture-test as usual.
- [ ] **Nedbank (SuccessFactors):** inspect whether the career-site search exposes JSON; fall back to HTML parsing (cheerio). Extra-strict guardrails — HTML scrapes are the ones that break silently.
- [ ] **Capitec (custom/Graylink):**
  - Recon first: network inspector on the careers site; look for any JSON the frontend consumes before assuming raw HTML scraping.
  - Respect robots.txt and modest request rates; honest User-Agent with contact URL.
  - Budget for a headless-browser fallback (Playwright in Actions) only if plain fetch fails — avoid it if possible (slower, flakier).
  - Entry-level roles are the payoff: verify branch/sales listings normalize into `Branch & Retail` / `Sales` categories correctly.
### Long-tail banks (ATS recon done 21 Jul 2026 — ordered easiest first)

Live recon (curl probes against each careers site) confirmed every bank's ATS and tested for JSON APIs. None of the five fits the existing Workday/SmartRecruiters clients as a pure config entry; ranked by expected effort:

- [ ] **GoTyme Bank (ex-TymeBank) — cleanest data.** Workable ATS with a public no-auth JSON API: `POST https://apply.workable.com/api/v3/accounts/gotyme-za-south-africa/jobs` (POST-only; GET 404s). Standard, documented adapter target — but the feed had **0 open roles** at recon, so build when postings reappear and verify field completeness against a real record then. Naming: tymebank.co.za 301s to gotyme.co.za — the SA bank rebranded to GoTyme Bank; alias TymeBank ↔ GoTyme Bank ZA and don't confuse with GoTyme Philippines (gotyme.com.ph, separate stack). The Workable slug is not linked from the bank's own site — pin it in adapter config. Legacy tyme-bank.breezy.hr is dead; ignore it.
- [ ] **Investec — clean per-job data, bespoke listing crawl.** eArcu ATS at careers.investec.co.za (the corporate www.investec.com is Cloudflare-Turnstile-walled; never fetch it). No bulk JSON API, but every job detail page embeds a schema.org `JobPosting` JSON-LD block (title, full description, location + geo, employmentType, req ID). Two-step adapter: GET the search page to mint session cookie + `pagestamp` → call the `posbrowser_gridhandler` AJAX endpoint (returns an HTML fragment) for detail URLs → parse each detail page's JSON-LD. ~5 SA roles at recon. Gotchas: `datePosted` is junk (always renders as "today" — rely on our firstSeen); `validThrough` can lapse while a job is still listed — never use it for closure.
- [ ] **Discovery Bank — scrapeable HTML, no API.** SAP SuccessFactors Career Site Builder at careers.discovery.co.za, group-wide feed, no JSON API (the RSS feed is robots.txt-disallowed and capped at ~10 items — don't use it). Server-rendered plain HTML (no headless browser) with schema.org microdata and an explicit "Business Unit" field (`customfield1`) whose exact value "Discovery Bank" is the filter key — but server-side filtering doesn't work, so crawl all group roles (~47 across 2 listing pages at recon; only **2** were Discovery Bank) and filter client-side each run. Same ATS class as Nedbank — build alongside the Nedbank SuccessFactors adapter and share the pattern.
- [ ] **African Bank — hardest source that has data.** "Career Focus" portal (afb.outsourcefocus.co.za): legacy ASP.NET WebForms — ~245KB `__VIEWSTATE`, rotating session cookies, full `__doPostBack` required to even run a search, no JSON/RSS surface. The main africanbank.co.za site 403s plain fetches behind a Cloudflare JS challenge. Needs Playwright-class automation and will be brittle; defer until the Capitec headless pattern exists, then reassess.
- [x] **Bank Zero — DEFERRED (written deferral).** No careers infrastructure at all: "Join Us" page is a contact email + phone number; no ATS, no listings, no LinkedIn Jobs presence (~34 staff). Acquired by Lesaka Technologies in 2025 — re-check quarterly in case hiring consolidates onto a group-level ATS.

**Exit criteria:** Capitec entry-level roles live and stable for 2 weeks of scheduled runs; each long-tail bank either has a live adapter or a written deferral.

---

## 5. Phase 4 — Enhance (deliberate scope decision, not default)

Only if Phases 1–3 are stable and low-maintenance:

- [ ] Job alerts by email: requires storing subscriber emails → **re-opens POPIA obligations** (consent, deletion, privacy policy). Storage: Workers KV or a separate store — not D1 user writes.
- [ ] Saved jobs: prefer localStorage-only (no accounts, no server state) to preserve the zero-personal-data posture.
- [ ] Custom `.co.za` domain if organic traffic justifies it.

---

## 6. Cross-cutting checklists

### Legal/compliance (before public launch)
- [ ] Excerpt-only descriptions with prominent link-out (copyright posture).
- [ ] No bank logos anywhere; nominative use of names only.
- [ ] "Independent and unaffiliated" disclaimer on every page footer + about page.
- [ ] Takedown/contact email published and monitored.
- [ ] Privacy-friendly analytics only (e.g. Cloudflare Web Analytics — no cookies, no personal data).
- [ ] robots.txt honored for all scraped sources; polite rate limits documented per adapter.

### Operational runbook (write as you build)
- [ ] "Feed broke" procedure: check `ingestion_runs` warning → refresh fixture from live response → fix adapter → re-run manually via workflow dispatch.
- [ ] "Mass closure scare" procedure: guardrail skipped closures — verify manually before force-closing.
- [ ] Quota watch: monthly glance at Workers requests/day and D1 reads/day vs free limits (Appendix A of PRD).

---

## 7. Sequencing summary

| Order | Work | Why this order |
|---|---|---|
| 1 | Schema + canonical model | Everything maps into it |
| 2 | Core utilities (sanitize, locations, taxonomy) | Adapters need them |
| 3 | Absa adapter (vertical slice to local DB) | Retires Workday risk; FirstRand nearly free after |
| 4 | FirstRand + Standard Bank adapters | Widen coverage on proven pattern |
| 5 | Orchestrator + closure policy + guardrails | The product's trust core |
| 6 | GitHub Actions + D1 wiring | Automation before UI |
| 7 | Worker API + Astro site + JSON-LD | UI last, on real data |
| 8 | Deploy, Search Console, user validation | Phase 1 gate |
| 9 | SEO landing pages, monitoring polish | Phase 2 |
| 10 | SARB → Nedbank → Capitec | Hardest last, gated on validation |
| 11 | Long-tail banks: GoTyme → Investec → Discovery Bank → African Bank (Bank Zero deferred) | Recon done 21 Jul 2026; ordered easiest first |

---

*Estimates assume ~8–10 focused hours per weekend. The single biggest schedule risk is Capitec (Phase 3); the single biggest quality risk is silent scrape corruption, which is why guardrails land in Phase 1, not later.*
