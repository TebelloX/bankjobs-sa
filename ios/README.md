# MyBankJobs iOS

Native SwiftUI iPhone app replicating [mybankjobs.co.za](https://mybankjobs.co.za) — same data,
same ledger aesthetic, same honesty conventions. Read-only client of the site's public snapshots
(`/data/*.json`, unmetered Pages) plus the Worker API for single job details only.

## Layout

- `BankJobs.xcodeproj` — app project (Xcode 16+ synchronized folder groups: adding Swift files
  under `BankJobs/` needs no project edits).
- `BankJobs/` — SwiftUI app target: screens, components, design system, assets. UI only.
- `JobsKit/` — Swift package holding **all** logic and data code, UI-free so `swift test` runs on
  macOS without a simulator. Ports of the site's TypeScript modules live here; treat the site's
  `site/src/lib/*.ts` as the spec when touching them.
- `tools/emit-fit-parity.mts` — regenerates the cross-language parity fixture that pins the Swift
  fit matcher to the website's actual TypeScript behavior.

## Build & test

```sh
# Logic tests (fast, no simulator)
cd ios/JobsKit && swift test

# App build
cd ios && xcodebuild build -project BankJobs.xcodeproj -scheme BankJobs \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO

# Regenerate the fit parity fixture after any change to site/src/lib/matchFit.ts
# or packages/core/src/keywords.ts (run from the repo root):
pnpm exec tsx ios/tools/emit-fit-parity.mts
```

If the parity suite in `JobsKitTests` fails after a site matcher change, the fixture caught real
drift — port the change to `JobsKit/Sources/JobsKit/Logic/FitMatcher.swift`, don't loosen the test.

## One-time setup after Apple Developer enrollment

1. Note the Team ID from the membership page (format `A1B2C3D4E5`).
2. Replace `TEAMID` in `site/public/.well-known/apple-app-site-association` and deploy the site.
   Verify: `curl -sI https://mybankjobs.co.za/.well-known/apple-app-site-association` → 200,
   `application/json`; then `curl https://app-site-association.cdn-apple.com/a/v1/mybankjobs.co.za`
   (Apple's CDN caches ~24 h — deploy well before TestFlight testing).
3. In Xcode: Signing & Capabilities → select the team (bundle id `za.co.mybankjobs.app`,
   automatic signing; Associated Domains `applinks:mybankjobs.co.za` is already in the
   entitlements).

## Release flow

- `MARKETING_VERSION` = user-visible version (1.0, 1.0.1, 1.1). `CURRENT_PROJECT_VERSION` = plain
  incrementing integer, bumped before every archive, never reset.
- Product → Archive → Distribute → App Store Connect → TestFlight internal (instant) → submit the
  same build for review → release manually.
- Tag the archived commit: `ios-v1.0-b<buildnumber>`.

## App Store Connect checklist (v1)

| Item | Value |
|---|---|
| Name | **MyBankJobs** |
| Subtitle | Every SA bank vacancy |
| Category | Business |
| Age rating | 4+ |
| Privacy nutrition label | **Data Not Collected** (no accounts, no analytics, all state on-device — invalidated if any analytics/crash SDK is ever added) |
| Privacy policy URL | https://mybankjobs.co.za/privacy/ |
| Keywords | generic only — e.g. `bank jobs, vacancies, south africa, careers, graduate, learnership`. **Never bank names** (FNB/Absa/… in metadata is a 2.3.7/5.2 rejection trigger) |
| Screenshots | one set: 6.9" **1320×2868** portrait, 3–5 images, **no bank logos visible** |
| Export compliance | already answered: `ITSAppUsesNonExemptEncryption = NO` in Info.plist |
| Content rights | Yes, third-party content: public factual job postings, aggregated, each linking to the official source |

**App Review notes (paste roughly this):**

> MyBankJobs is a job-listings aggregator for South African banking vacancies. All listings are
> public job postings from the banks' official career sites; each listing links to the official
> application page — no applications happen in the app. We are independent and not affiliated with
> any bank; the app states this on its About screen. Content disputes: tebellonamo@gmail.com.
> No account is needed; all user data stays on-device; the app collects nothing.

## Deferred to v1.1

APNs push (needs a device-token endpoint + D1 table + digest sender server-side), iPad,
`ios.yml` CI workflow (workflow-level `paths: ['ios/**']`, unsigned simulator build), API-mode
search, widgets.
