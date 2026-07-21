/**
 * Re-capture the committed fixtures from the LIVE endpoints.
 *   pnpm --filter @bankjobs/adapters run capture -- --source=absa
 *   pnpm --filter @bankjobs/adapters run capture -- --source=firstrand
 *   pnpm --filter @bankjobs/adapters run capture -- --source=standardbank
 *
 * This talks to the network. It re-verifies the list endpoint first; if it has
 * drifted it prints guidance and exits non-zero rather than writing garbage over
 * the ground-truth fixtures. Do not run this in CI or tests — the tests read the
 * committed fixtures offline. Default source is absa.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeLocation } from '@bankjobs/core';

import { ABSA_WORKDAY_CONFIG } from '../src/absa';
import { FIRSTRAND_WORKDAY_CONFIG } from '../src/firstrand';
import { STANDARDBANK_SR_CONFIG } from '../src/standardbank';
import { INVESTEC_EARCU_CONFIG } from '../src/investec';
import { BROWSER_UA, HONEST_UA } from '../src/workday/client';
import type { WorkdayConfig } from '../src/workday/client';
import type { WorkdayJobDetail, WorkdayListResponse } from '../src/workday/types';
import { SMARTRECRUITERS_UA } from '../src/smartrecruiters/client';
import type { SmartRecruitersConfig } from '../src/smartrecruiters/client';
import type { SrListResponse, SrPostingDetail } from '../src/smartrecruiters/types';
import {
  EARCU_UA,
  cookieHeaderFrom,
  extractDetailUrls,
  extractJobPostingLd,
  extractPagestamp,
} from '../src/earcu/client';
import type { EarcuConfig } from '../src/earcu/client';
import type { EarcuJobPosting } from '../src/earcu/types';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(scriptDir, '../../../fixtures');

function withUserAgent(init: RequestInit, ua: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), 'User-Agent': ua },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A title heuristic to pick an "IT-ish" posting for variety.
const IT_TITLE_RE =
  /\b(analyst|developer|engineer|software|data|it|technolog|solution|architect|devops|programmer|cyber|digital)\b/i;

const KNOWN_SUB_BRANDS = new Set(['FNB', 'RMB', 'WesBank', 'Ashburton', 'DirectAxis']);

// ---------------------------------------------------------------------------
// Workday sources (absa, firstrand).
// ---------------------------------------------------------------------------

async function captureWorkday(source: 'absa' | 'firstrand', cfg: WorkdayConfig): Promise<void> {
  const pageSize = cfg.pageSize ?? 20;
  const delayMs = cfg.delayMs ?? 400;
  const fixturesDir = join(fixturesRoot, source);
  const listUrl = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}/jobs`;
  const detailBase = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}`;

  // Mirror the client UA policy: honest first, browser fallback on 406.
  let resolvedUa: string | undefined;
  async function wdFetch(url: string, init: RequestInit): Promise<Response> {
    if (resolvedUa !== undefined) return fetch(url, withUserAgent(init, resolvedUa));
    const res = await fetch(url, withUserAgent(init, HONEST_UA));
    if (res.status === 406) {
      resolvedUa = BROWSER_UA;
      return fetch(url, withUserAgent(init, BROWSER_UA));
    }
    resolvedUa = HONEST_UA;
    return res;
  }

  async function fetchDetail(
    externalPath: string,
  ): Promise<{ detail: WorkdayJobDetail; text: string }> {
    await sleep(delayMs);
    const res = await wdFetch(`${detailBase}${externalPath}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) {
      throw new Error(`Detail request for ${externalPath} returned HTTP ${res.status}`);
    }
    const text = await res.text();
    return { detail: JSON.parse(text) as WorkdayJobDetail, text };
  }

  const listRes = await wdFetch(listUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: pageSize, offset: 0, searchText: '' }),
  });
  if (listRes.status !== 200) {
    console.error(
      `${source} list endpoint returned HTTP ${listRes.status} — site name may have drifted.`,
    );
    console.error(`Tried: POST ${listUrl}`);
    process.exit(1);
  }

  const listText = await listRes.text();
  const list = JSON.parse(listText) as WorkdayListResponse;
  writeFileSync(join(fixturesDir, 'list-page1.json'), listText);
  console.log(`Wrote list-page1.json (${list.jobPostings.length} postings, total ${list.total}).`);

  const postings = list.jobPostings.filter((p) => Boolean(p.externalPath) && Boolean(p.title));

  if (source === 'absa') {
    // Variety: an SA non-IT role, an IT-ish role, and a non-SA role.
    let saNonIt, itish, nonSa;
    for (const posting of postings) {
      if (saNonIt && itish && nonSa) break;
      const captured = await fetchDetail(posting.externalPath);
      const info = captured.detail.jobPostingInfo;
      const isSa = (info.country?.descriptor ?? '') === 'South Africa';
      if (!isSa) nonSa ??= captured;
      else if (IT_TITLE_RE.test(info.title)) itish ??= captured;
      else saNonIt ??= captured;
    }
    if (!saNonIt || !itish || !nonSa) {
      console.error('Could not find all three fixture varieties on page 1.');
      process.exit(1);
    }
    writeFileSync(join(fixturesDir, 'detail-1.json'), saNonIt.text);
    writeFileSync(join(fixturesDir, 'detail-2.json'), itish.text);
    writeFileSync(join(fixturesDir, 'detail-3.json'), nonSa.text);
    writeManifest(fixturesDir, {
      source,
      listUrl,
      detailBase,
      total: list.total,
      pageSize,
      files: {
        'detail-1.json': fileNote(saNonIt.detail, 'SA non-IT'),
        'detail-2.json': fileNote(itish.detail, 'IT-ish'),
        'detail-3.json': fileNote(nonSa.detail, 'non-ZA test case'),
      },
    });
    console.log(`Wrote detail-1/2/3.json + manifest.json to ${fixturesDir}.`);
    return;
  }

  // firstrand: variety across sub-brands (FNB / RMB / WesBank) + a non-SA role.
  // The sub-brand is the LAST bulletField of the list item.
  const bySubBrand = new Map<string, { detail: WorkdayJobDetail; text: string }>();
  let nonSa: { detail: WorkdayJobDetail; text: string } | undefined;
  const wanted = ['FNB', 'RMB', 'WesBank'];
  for (const posting of postings) {
    const enough = wanted.every((b) => bySubBrand.has(b)) && nonSa;
    if (enough) break;
    const last = posting.bulletFields[posting.bulletFields.length - 1];
    const brand = last && KNOWN_SUB_BRANDS.has(last) ? last : 'FirstRand';
    const country = posting.bulletFields.length >= 2 ? posting.bulletFields[1] : '';
    const isSa = country === 'South Africa';
    const needBrand = wanted.includes(brand) && !bySubBrand.has(brand);
    const needNonSa = !isSa && !nonSa;
    if (!needBrand && !needNonSa) continue;
    const captured = await fetchDetail(posting.externalPath);
    if (needBrand) bySubBrand.set(brand, captured);
    if (needNonSa) nonSa = captured;
  }
  const fnb = bySubBrand.get('FNB');
  const rmb = bySubBrand.get('RMB');
  const wesbank = bySubBrand.get('WesBank');
  if (!fnb || !rmb || !wesbank || !nonSa) {
    console.error(
      'Could not find all four FirstRand fixture varieties on page 1 (widen the search).',
    );
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'detail-1.json'), fnb.text);
  writeFileSync(join(fixturesDir, 'detail-2.json'), rmb.text);
  writeFileSync(join(fixturesDir, 'detail-3.json'), wesbank.text);
  writeFileSync(join(fixturesDir, 'detail-4.json'), nonSa.text);
  writeManifest(fixturesDir, {
    source,
    listUrl,
    detailBase,
    total: list.total,
    pageSize,
    files: {
      'detail-1.json': fileNote(fnb.detail, 'brand FNB'),
      'detail-2.json': fileNote(rmb.detail, 'brand RMB'),
      'detail-3.json': fileNote(wesbank.detail, 'brand WesBank'),
      'detail-4.json': fileNote(nonSa.detail, 'non-ZA test case'),
    },
  });
  console.log(`Wrote detail-1..4.json + manifest.json to ${fixturesDir}.`);
}

function fileNote(detail: WorkdayJobDetail, tag: string): string {
  const info = detail.jobPostingInfo;
  return `${info.jobReqId} — ${info.title}, ${info.location} (${tag})`;
}

// ---------------------------------------------------------------------------
// SmartRecruiters source (standardbank).
// ---------------------------------------------------------------------------

async function captureSmartRecruiters(cfg: SmartRecruitersConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const listLimit = 20; // small representative first page for the fixture
  const fixturesDir = join(fixturesRoot, 'standardbank');
  const base = `https://api.smartrecruiters.com/v1/companies/${cfg.company}/postings`;

  async function srFetch(url: string): Promise<Response> {
    return fetch(url, {
      headers: { 'User-Agent': SMARTRECRUITERS_UA, Accept: 'application/json' },
    });
  }

  const listUrl = `${base}?limit=${listLimit}&offset=0`;
  const listRes = await srFetch(listUrl);
  if (listRes.status !== 200) {
    console.error(`standardbank list endpoint returned HTTP ${listRes.status}.`);
    console.error(`Tried: GET ${listUrl}`);
    process.exit(1);
  }
  const listText = await listRes.text();
  const list = JSON.parse(listText) as SrListResponse;
  writeFileSync(join(fixturesDir, 'list-page1.json'), listText);
  console.log(
    `Wrote list-page1.json (${list.content.length} postings, totalFound ${list.totalFound}).`,
  );

  async function fetchDetail(id: string): Promise<{ detail: SrPostingDetail; text: string }> {
    await sleep(delayMs);
    const res = await srFetch(`${base}/${id}`);
    if (res.status !== 200) throw new Error(`Detail request for ${id} returned HTTP ${res.status}`);
    const text = await res.text();
    return { detail: JSON.parse(text) as SrPostingDetail, text };
  }

  // Variety: an SA branch/retail role, an SA IT role, and a non-SA role.
  let saBranch, saIt, nonSa;
  for (const posting of list.content) {
    if (saBranch && saIt && nonSa) break;
    const isSa = (posting.location?.country ?? '') === 'za';
    const captured = await fetchDetail(posting.id);
    if (!isSa) nonSa ??= captured;
    else if (IT_TITLE_RE.test(posting.name)) saIt ??= captured;
    else saBranch ??= captured;
  }
  if (!saBranch || !saIt || !nonSa) {
    console.error('Could not find all three standardbank fixture varieties on page 1.');
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'detail-1.json'), saBranch.text);
  writeFileSync(join(fixturesDir, 'detail-2.json'), saIt.text);
  writeFileSync(join(fixturesDir, 'detail-3.json'), nonSa.text);

  const manifest = {
    source: 'standardbank',
    capturedAt: new Date().toISOString(),
    endpoints: {
      list: `GET ${base}?limit=100&offset=N`,
      detail: `GET ${base}/{id}`,
    },
    totalAtCapture: list.totalFound,
    files: {
      'list-page1.json': `First list page, limit ${listLimit}, offset 0`,
      'detail-1.json': `${saBranch.detail.id} — ${saBranch.detail.name}`,
      'detail-2.json': `${saIt.detail.id} — ${saIt.detail.name}`,
      'detail-3.json': `${nonSa.detail.id} — ${nonSa.detail.name} (non-ZA test case)`,
    },
    notes: [
      'Public documented API, no auth, no User-Agent restrictions; pagination cap is 100 per page.',
      "location.country is a LOWERCASE ISO alpha-2 code ('za', 'im', 'ng') — uppercase it directly.",
      'postedDate: use the date part of releasedDate.',
      'Description HTML lives in jobAd.sections; companyDescription/additionalInformation are boilerplate.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1/2/3.json + manifest.json to ${fixturesDir}.`);
}

// ---------------------------------------------------------------------------
// eArcu source (investec).
// ---------------------------------------------------------------------------

async function captureEarcu(cfg: EarcuConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const resultsPath = cfg.resultsPath ?? '/jobs/vacancy/find/results/';
  const origin = `https://${cfg.host}`;
  const fixturesDir = join(fixturesRoot, 'investec');

  const eaFetch = (url: string, cookie?: string): Promise<Response> =>
    fetch(url, {
      headers: {
        'User-Agent': EARCU_UA,
        ...(cookie ? { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest' } : {}),
      },
    });

  // 1) results page → cookies + pagestamp (rotates per load; never cached).
  const resultsUrl = `${origin}${resultsPath}`;
  const resultsRes = await eaFetch(resultsUrl);
  if (resultsRes.status !== 200) {
    console.error(`investec results page returned HTTP ${resultsRes.status}.`);
    console.error(`Tried: GET ${resultsUrl}`);
    process.exit(1);
  }
  const cookie = cookieHeaderFrom(resultsRes.headers.getSetCookie());
  const pagestamp = extractPagestamp(await resultsRes.text());
  if (!pagestamp) {
    console.error('investec results page carried no pagestamp — page shape may have drifted.');
    process.exit(1);
  }

  // 2) grid fragment → detail URLs (stored verbatim as ground truth).
  await sleep(delayMs);
  const gridUrl = `${origin}${resultsPath}ajaxaction/posbrowser_gridhandler/?pagestamp=${pagestamp}`;
  const gridRes = await eaFetch(gridUrl, cookie);
  if (gridRes.status !== 200) {
    console.error(`investec grid endpoint returned HTTP ${gridRes.status}.`);
    console.error(`Tried: GET ${gridUrl}`);
    process.exit(1);
  }
  const gridHtml = await gridRes.text();
  writeFileSync(join(fixturesDir, 'grid.html'), gridHtml);
  const detailUrls = extractDetailUrls(gridHtml, origin);
  console.log(`Wrote grid.html (${detailUrls.length} vacancies).`);

  // 3) detail pages → full HTML. Pick three for variety: a Western Cape city, a
  // Gauteng city, and a posting whose JSON-LD address is empty (city lives in
  // the title only) to exercise the no-location branch.
  let wc, gp, noLoc;
  for (const url of detailUrls) {
    if (wc && gp && noLoc) break;
    await sleep(delayMs);
    const res = await eaFetch(url);
    if (res.status !== 200) throw new Error(`Detail ${url} returned HTTP ${res.status}`);
    const html = await res.text();
    const posting = extractJobPostingLd(html);
    if (!posting) continue;
    const captured = { url, html, posting };
    const locality = firstLocality(posting);
    if (locality === null) {
      noLoc ??= captured;
      continue;
    }
    const province = normalizeLocation(locality).province;
    if (province === 'Western Cape') wc ??= captured;
    else if (province === 'Gauteng') gp ??= captured;
  }
  const chosen = [wc, gp, noLoc].filter((c) => c !== undefined);
  if (chosen.length < 3) {
    console.error('Could not find all three investec fixture varieties (WC / Gauteng / no-city).');
    process.exit(1);
  }
  chosen.forEach((c, i) => writeFileSync(join(fixturesDir, `detail-${i + 1}.html`), c.html));

  const manifest = {
    source: 'investec',
    capturedAt: new Date().toISOString(),
    ats: 'eArcu',
    endpoints: {
      results: `GET ${resultsUrl}`,
      grid: `GET ${origin}${resultsPath}ajaxaction/posbrowser_gridhandler/?pagestamp={pagestamp}`,
      detail: `GET ${origin}/jobs/vacancy/{slug}/{id}/description/`,
    },
    totalAtCapture: detailUrls.length,
    files: {
      'grid.html': 'The grid AJAX HTML fragment; anchors are the detail-page URLs.',
      'detail-1.html': fileNoteEarcu(wc),
      'detail-2.html': fileNoteEarcu(gp),
      'detail-3.html': fileNoteEarcu(noLoc),
    },
    notes: [
      'Corporate www.investec.com is behind Cloudflare Turnstile and 403s bots — NEVER fetch it; only careers.investec.co.za is used.',
      'The results page sets session cookies (earcusessionid, earcusession, __cf_bm) and embeds a per-load pagestamp that rotates on every load.',
      'The grid endpoint returns text/html (Accept: application/json is ignored) and needs the session cookie + that pagestamp.',
      'Detail pages are stable and cookie-free; each embeds ONE application/ld+json JobPosting block.',
      'id = investec:{identifier.value} (identifier is a PropertyValue object; value is the req number).',
      'datePosted is templated to today (untrusted) and validThrough is unreliable — postedDate is set null.',
      'applyUrl is the detail-page URL itself (the /action/apply/?pagestamp=... link is session-bound).',
      'addressCountry is a display name (South Africa) — map via countryCodeFor; addressLocality can be empty.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1/2/3.html + manifest.json to ${fixturesDir}.`);
}

/** The first jobLocation's city, or null when the address carries none. */
function firstLocality(posting: EarcuJobPosting): string | null {
  const place = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
  const locality = place?.address?.addressLocality?.trim();
  return locality ? locality : null;
}

function fileNoteEarcu(captured: { url: string; posting: EarcuJobPosting } | undefined): string {
  if (!captured) return '';
  const id =
    typeof captured.posting.identifier === 'string'
      ? captured.posting.identifier
      : (captured.posting.identifier?.value ?? '?');
  const locality = firstLocality(captured.posting) ?? 'no city in JSON-LD';
  return `${String(id)} — ${captured.posting.title ?? '?'} (${locality})`;
}

interface WorkdayManifestArgs {
  source: string;
  listUrl: string;
  detailBase: string;
  total: number;
  pageSize: number;
  files: Record<string, string>;
}

function writeManifest(fixturesDir: string, args: WorkdayManifestArgs): void {
  const manifest = {
    source: args.source,
    capturedAt: new Date().toISOString(),
    endpoints: {
      list: `POST ${args.listUrl}`,
      detail: `GET ${args.detailBase}{externalPath}`,
    },
    totalAtCapture: args.total,
    files: {
      'list-page1.json': `First list page, limit ${args.pageSize}, offset 0`,
      ...args.files,
    },
    notes: [
      'Workday returns 406 for non-browser User-Agents; captured with a Chrome UA + Accept: application/json.',
      'jobPostingInfo.country is an object {descriptor, id} — map descriptor to ISO alpha-2.',
      'jobPostingInfo.startDate is the ISO posted date; postedOn is relative text.',
      'Page size caps at 20 regardless of requested limit.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { source: { type: 'string', default: 'absa' } },
    allowPositionals: false,
  });
  const source = values.source;

  switch (source) {
    case 'absa':
      await captureWorkday('absa', ABSA_WORKDAY_CONFIG);
      return;
    case 'firstrand':
      await captureWorkday('firstrand', FIRSTRAND_WORKDAY_CONFIG);
      return;
    case 'standardbank':
      await captureSmartRecruiters(STANDARDBANK_SR_CONFIG);
      return;
    case 'investec':
      await captureEarcu(INVESTEC_EARCU_CONFIG);
      return;
    default:
      console.error(
        `Unknown --source '${source}' (expected absa | firstrand | standardbank | investec).`,
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
