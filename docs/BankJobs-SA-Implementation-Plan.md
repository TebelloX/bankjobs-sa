# BankJobs SA — Implementation Plan

**Version:** 0.11 · **Date:** 21 July 2026 · **Companion to:** BankJobs SA PRD v0.2

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

### 2.5 GitHub Actions wiring — DONE 21 Jul 2026

- [x] `ingest.yml`: cron 3×/day (06:00, 12:00, 18:00 SAST), manual dispatch with an `only` (single-source override) and `dry_run` input. Only secret required is `CLOUDFLARE_API_TOKEN` — the account and database ids are identifiers, not credentials, so they're inlined in the workflow rather than stored as secrets.
- [x] Per-source steps (`continue-on-error: true`) so one bank's outage can't block the rest; a final rollup step inspects `steps.*.outcome` and fails the run if any source didn't come back clean, so it goes red for a human to check without needing to open every step's log (Actions' default failure-notification email still fires off that rollup). gotyme stays excluded from the workflow — seeded `enabled=0` because its feed is empty, and running it explicitly would trip the zero-jobs guardrail; add its step back once `sources.enabled` flips to 1.
- [x] `ci.yml`: `pnpm typecheck` + `pnpm test` on PR and push to main.
- [x] **Remote D1 write-path decisions:** the D1 REST driver lives behind the same async `JobsDb` seam the local SQLite driver implements, so CI needs no `wrangler` install or auth beyond the three env vars. Lifecycle updates (closures, `missedRuns` bumps) batch via chunked `WHERE id IN (...)`, capped at 80 ids per statement, to respect both Cloudflare's API rate limit and D1's 100-bound-parameter ceiling per statement. Remote writes are per-statement rather than wrapped in an explicit transaction — the diff/upsert flow is idempotent, so a run that dies partway self-heals on the next scheduled trigger instead of needing a rollback. Static snapshots (`/data/*.json`) remain local-only for now; giving the site build a D1-fed data path is deferred to the deploy milestone (2.8).

### 2.6 Read API (Worker) — BUILT 21 Jul 2026, locally proven; remote D1 spike still gates deploy

- [x] `GET /api/jobs` — `q` (FTS5 MATCH, bm25-ranked, input sanitized to quoted prefix tokens so operators/quotes can't inject or 500), `category` (name or slug), `province`, `city`, `source`, `country`, capped pagination. Reads via D1 Sessions API (`withSession('first-unconstrained')` — supported by miniflare, exercised in tests).
- [x] `GET /api/jobs/:id` (open jobs only, full description), `GET /api/meta` (mirrors snapshot meta aggregates).
- [x] Edge caching: Cache API on a normalized URL (sorted/whitelisted params), `max-age=300, s-maxage=900`; cache HITs served before the rate limiter spends a token.
- [x] Per-IP token bucket (in-memory per-isolate — documented caveat; adequate free-tier protection), 429 + Retry-After.
- [x] FTS5+triggers spike, LOCAL: `packages/api/test/d1-fts-spike.test.ts` proves the virtual table, all three triggers (incl. lifecycle-only updates NOT churning the index), and bm25 ranking against real workerd D1.
- [x] **FTS5+triggers spike, REMOTE — PASSED 21 Jul 2026.** `bankjobs` D1 created (WEUR, id wired into wrangler.jsonc), schema applied cleanly, spike matched its expected table row-for-row on managed D1. The ingest-maintains-index fallback is not needed. (Remote quirk worth remembering: multi-statement `--file` returns only aggregate stats — replay via `--command` to see rows.)
- [ ] Deploy-time: decide the route/domain, `wrangler deploy`.

### 2.7 Astro frontend

- [ ] Pages: home/browse (reads static `/data/*.json`), search results (calls Worker), job detail, about/legal page (unaffiliated disclaimer + takedown contact).
- [ ] Job detail: title, bank, location, posted date, excerpt, **prominent "Apply on [Bank]'s official site" button**, `JobPosting` JSON-LD (`directApply: false`, `validThrough` = lastSeen + closure window).
- [ ] "Last updated" indicator from `meta.json`.
- [ ] Page-weight budget: ≤150 KB first browse view. No client framework on browse pages — Astro islands only for the search box.
- [ ] Semantic HTML, keyboard navigation, WCAG 2.1 AA basics.
- [ ] Sitemap (job detail URLs + browse pages), robots.txt.

### 2.8 Deploy & validate

- [x] **Cloudflare Pages project (site) + Worker (api) + D1 (prod DB) — DONE 21 Jul 2026.** `bankjobs` D1 created and wired (see §2.6); Pages project `bankjobs-sa` (production branch `main`) and Worker `bankjobs-api` deploy from `.github/workflows/deploy.yml` (push to `main`, plus `workflow_dispatch` with a `worker` input) and from `ingest.yml`'s `publish-site` job after every scheduled ingest. Both free `pages.dev`/`workers.dev` domains, as planned — no custom domain at launch. Deploy jobs are auth-blocked until the `CLOUDFLARE_API_TOKEN` is widened past its current `D1:Edit`-only scope with `Workers Scripts:Edit` + `Cloudflare Pages:Edit` (README documents the one-time steps); that token edit and the resulting first live deploy are still outstanding.
- [x] **Site data path from D1 — DONE 21 Jul 2026.** `pnpm ingest -- --snapshot-only --remote` regenerates `site/public/data/*.json` + `site/src/data/jobs-full.json` directly from production D1 before every build, in both deploy workflows — closing the gap noted in §2.5 (snapshots were local-only until this milestone).
- [x] **Search → Worker wiring, env-gated — DONE 21 Jul 2026.** Site build accepts `PUBLIC_SEARCH_MODE=api` + `PUBLIC_API_BASE=<worker url>`, sourced from repository variable `vars.PUBLIC_API_BASE`; empty until the first Worker deploy reveals its URL, and the build falls back to static-search mode by omitting both vars until then.
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

- [x] **SARB (Oracle Cloud Recruiting REST): DONE 21 Jul 2026.** Clean auth-less JSON API on `fa-evra-saasfaprod1.fa.ocs.oraclecloud.com` (siteNumber CX_1002, alias `SARB`); reusable oracle client built. The one real trap, guarded and tested: omitting `expand=requisitionList.workLocation` yields a 200 with the requisition list silently ABSENT — the client throws a descriptive error rather than reporting zero jobs. `Id` (human req number) is the key; `RequisitionId` surrogate ignored; titles arrive prefixed `"(1736) …"` and the echo is stripped only when it equals the req id. 25 roles live, all ZA (Pretoria head office). Never fetch www.resbank.co.za (WAF).
- [x] **Nedbank (SuccessFactors): DONE 21 Jul 2026 (bbb7bb4).** No JSON API, but the tenant's `/sitemap.xml` is a mislabeled, uncapped Google-for-Jobs RSS feed — all reqs in one GET, no cheerio needed. postedDate enriched non-fatally from detail-page microdata (absent on some pages by design tolerance). 77 jobs live (74 SA + 3 Namibia).
- [x] **Capitec: DONE 21 Jul 2026 — and it wasn't Graylink.** Recon found careers.capitecbank.co.za is SAP SuccessFactors CSB: server-rendered, robots-allowed real URL sitemap + detail-page microdata, no JSON API needed, **no headless browser needed**. Reuses the shared SuccessFactors sitemap strategy (parser made tolerant of Capitec's two microdata shape variants; Discovery's output unchanged). 51 roles live, all SA. **Mission caveat: the channel currently lists ZERO frontline branch roles** (no Bank Better Champion / Service Consultant) — inventory is corporate/HQ plus graduate/internship pipelines; branch/teller recruitment likely runs through a separate high-volume channel (detail pages link out to SHL Talent Central assessments). A `'bank better champion' → Branch & Retail` rule is pre-seeded so frontline roles categorize correctly the moment they appear. Monitor the mix across scheduled runs before concluding the mission payoff needs another channel. Never fetch www.capitecbank.co.za (Cloudflare-challenged); the careers subdomain is unprotected.
### Long-tail banks (ATS recon done 21 Jul 2026 — ordered easiest first)

Live recon (curl probes against each careers site) confirmed every bank's ATS and tested for JSON APIs. None of the five fits the existing Workday/SmartRecruiters clients as a pure config entry; ranked by expected effort:

- [x] **GoTyme Bank (ex-TymeBank) — ADAPTER BUILT, armed but disabled (ea43899).** Workable client done (public no-auth JSON API, `gotyme-za-south-africa`); source seeded enabled=0 because the feed had 0 open roles at build time. When GoTyme posts roles: flip enabled to 1 and re-capture fixtures from the real account (current normalize fixtures are documented stand-ins — verify field completeness then). Naming: tymebank.co.za 301s to gotyme.co.za; don't confuse with GoTyme Philippines. Legacy tyme-bank.breezy.hr is dead.
- [x] **Investec — DONE 21 Jul 2026 (c53c08a).** eArcu adapter live: session cookie + pagestamp → `posbrowser_gridhandler` HTML fragment → per-page JSON-LD. 5 SA roles at launch. Standing gotchas honoured in code: `datePosted` is templated junk (postedDate stays null, firstSeen carries recency); `validThrough` never used for closure; corporate www.investec.com is Cloudflare-walled — never fetched.
- [x] **Discovery Bank — DONE 21 Jul 2026.** Built on the shared SuccessFactors client's second (sitemap) strategy: unlike Nedbank's tenant, Discovery's `/sitemap.xml` is a real URL sitemap (48 job URLs), so detail pages are load-bearing — crawl all, parse microdata + labelled `customfield1` fields, filter to Business Unit = "Discovery Bank" client-side (server-side filtering doesn't work), log the group/kept/skipped split every run. 2 bank roles of 48 group postings at launch; with counts this low a legitimate zero will trip the zero-jobs guardrail into warn-and-skip-closures — expected, not a bug. The `/services/` RSS stays untouched (robots-disallowed); apply links use the stable `/job/` page because `/talentcommunity/apply/` is robots-disallowed and session-bound.
- [ ] **African Bank — hardest source that has data.** "Career Focus" portal (afb.outsourcefocus.co.za): legacy ASP.NET WebForms — ~245KB `__VIEWSTATE`, rotating session cookies, full `__doPostBack` required to even run a search, no JSON/RSS surface. The main africanbank.co.za site 403s plain fetches behind a Cloudflare JS challenge. Needs Playwright-class automation and will be brittle; defer until the Capitec headless pattern exists, then reassess.
- [x] **Bank Zero — DEFERRED (written deferral).** No careers infrastructure at all: "Join Us" page is a contact email + phone number; no ATS, no listings, no LinkedIn Jobs presence (~34 staff). Acquired by Lesaka Technologies in 2025 — re-check quarterly in case hiring consolidates onto a group-level ATS.

**Exit criteria:** Capitec source live and stable for 2 weeks of scheduled runs, with the entry-level mix monitored (frontline branch roles are not currently posted on the fetchable channel — the original "entry-level roles live" bar can only be met when Capitec posts them, or via a future second channel); each long-tail bank either has a live adapter or a written deferral.

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
