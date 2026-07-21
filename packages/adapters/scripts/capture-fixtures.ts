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
import { GOTYME_WORKABLE_CONFIG } from '../src/gotyme';
import { WORKABLE_UA } from '../src/workable/client';
import type { WorkableConfig } from '../src/workable/client';
import type { WorkableJobDetail, WorkableListResponse } from '../src/workable/types';
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
import { NEDBANK_SF_CONFIG } from '../src/nedbank';
import { SUCCESSFACTORS_UA, extractDatePosted, parseFeed } from '../src/successfactors/client';
import type { SuccessFactorsConfig } from '../src/successfactors/client';
import type { SfFeedItem } from '../src/successfactors/types';

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

// ---------------------------------------------------------------------------
// Workable source (gotyme).
// ---------------------------------------------------------------------------

// The real GoTyme feed is empty, so the populated-schema fixtures come from a
// public stand-in Workable account. 'careers' is Workable's own board — small
// (<=20 roles), stable, and unmistakably NOT GoTyme. Re-point this to re-capture
// the stand-ins reproducibly.
const WORKABLE_STANDIN_SLUG = 'careers';

async function captureWorkable(cfg: WorkableConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const fixturesDir = join(fixturesRoot, 'gotyme');
  const apiBase = 'https://apply.workable.com/api';

  const wkListUrl = (slug: string): string => `${apiBase}/v3/accounts/${slug}/jobs`;
  const wkDetailUrl = (slug: string, shortcode: string): string =>
    `${apiBase}/v1/accounts/${slug}/jobs/${shortcode}`;

  const postList = (url: string): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': WORKABLE_UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

  // 1) The REAL GoTyme empty list — today's ground truth (verify it is still 0;
  // a re-capture from a populated feed must replace the stand-ins entirely).
  const realUrl = wkListUrl(cfg.slug);
  const realRes = await postList(realUrl);
  if (realRes.status !== 200) {
    console.error(`gotyme real list endpoint returned HTTP ${realRes.status}.`);
    console.error(`Tried: POST ${realUrl}`);
    process.exit(1);
  }
  const realText = await realRes.text();
  const real = JSON.parse(realText) as WorkableListResponse;
  writeFileSync(join(fixturesDir, 'list-empty.json'), realText);
  console.log(`Wrote list-empty.json (real GoTyme feed, total ${real.total}).`);
  if (real.total !== 0) {
    console.warn(
      `NOTE: GoTyme now advertises ${real.total} roles — re-capture the real list/detail and RETIRE the stand-ins.`,
    );
  }

  // 2) Stand-in list page.
  await sleep(delayMs);
  const standinUrl = wkListUrl(WORKABLE_STANDIN_SLUG);
  const standinRes = await postList(standinUrl);
  if (standinRes.status !== 200) {
    console.error(`stand-in (${WORKABLE_STANDIN_SLUG}) list returned HTTP ${standinRes.status}.`);
    process.exit(1);
  }
  const standinText = await standinRes.text();
  const standin = JSON.parse(standinText) as WorkableListResponse;
  writeFileSync(join(fixturesDir, 'standin-list.json'), standinText);
  console.log(
    `Wrote standin-list.json (${standin.results.length} postings, total ${standin.total}).`,
  );

  // 3) Up to three stand-in details for schema variety.
  const chosen = standin.results.slice(0, 3);
  if (chosen.length === 0) {
    console.error(`Stand-in account ${WORKABLE_STANDIN_SLUG} has no open roles — pick another.`);
    process.exit(1);
  }
  const details: WorkableJobDetail[] = [];
  for (let i = 0; i < chosen.length; i += 1) {
    const item = chosen[i];
    if (!item) continue;
    await sleep(delayMs);
    const res = await fetch(wkDetailUrl(WORKABLE_STANDIN_SLUG, item.shortcode), {
      headers: { 'User-Agent': WORKABLE_UA, Accept: 'application/json' },
    });
    if (res.status !== 200) {
      throw new Error(`Detail ${item.shortcode} returned HTTP ${res.status}`);
    }
    const text = await res.text();
    details.push(JSON.parse(text) as WorkableJobDetail);
    writeFileSync(join(fixturesDir, `standin-detail-${i + 1}.json`), text);
  }

  const manifest = {
    source: 'gotyme',
    capturedAt: new Date().toISOString(),
    ats: 'Workable',
    brand: 'GoTyme Bank (ex-TymeBank; tymebank.co.za 301s to gotyme.co.za)',
    real: {
      slug: cfg.slug,
      note: 'Slug is NOT discoverable from gotyme.co.za HTML/sitemap — pinned in the adapter. Distinct from GoTyme Philippines (gotyme.com.ph).',
      list: `POST ${realUrl}`,
      corroborating: [
        `https://apply.workable.com/${cfg.slug}/jobs.md`,
        `https://apply.workable.com/${cfg.slug}/llms.txt`,
      ],
      totalAtCapture: real.total,
    },
    standin: {
      slug: WORKABLE_STANDIN_SLUG,
      why: "The real GoTyme feed is empty; this public Workable board pins the populated schema (client parsing + normalize mapping) against genuine payloads. Brand normalizes to 'GoTyme Bank' over this employer's data — intentional, schema-pinning only.",
      list: `POST ${wkListUrl(WORKABLE_STANDIN_SLUG)}`,
      detail: `GET ${wkDetailUrl(WORKABLE_STANDIN_SLUG, '{shortcode}')}`,
      totalAtCapture: standin.total,
    },
    files: {
      'list-empty.json': `Real GoTyme empty list (total ${real.total}) — today's ground truth.`,
      'standin-list.json': `Stand-in list page (${standin.results.length} postings).`,
      ...Object.fromEntries(
        details.map((d, i) => [
          `standin-detail-${i + 1}.json`,
          `${d.shortcode} — ${d.title} (${d.location?.city ?? 'no city'}, ${d.location?.country ?? '?'})`,
        ]),
      ),
    },
    notes: [
      'List is v3 POST-only (GET 404s); page 1 body {}, subsequent pages echo the response nextPage cursor back as the request body {token}.',
      'Detail is the v1 GET endpoint (v3 has no per-job GET); it carries the HTML body in description + requirements + benefits.',
      'No apply-URL field: the durable public job page is https://apply.workable.com/{slug}/j/{shortcode}/.',
      'location.country is a DISPLAY name (mapped via countryCodeFor); countryCode/type/published/department are also present.',
      'RE-CAPTURE from the real account and retire the stand-ins the moment GoTyme posts roles (verify field completeness first).',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote standin-detail-1..${details.length}.json + manifest.json to ${fixturesDir}.`);
}

// ---------------------------------------------------------------------------
// SuccessFactors CSB source (nedbank).
// ---------------------------------------------------------------------------

/** [city, ISO alpha-2] from a g:location 'City, CC' (mirrors the adapter). */
function splitSfLocation(raw: string): { city: string; country: string } {
  const m = /^(.*?),\s*([A-Za-z]{2})$/.exec(raw.trim());
  if (!m) return { city: raw.trim(), country: 'ZZ' };
  return { city: (m[1] ?? '').trim(), country: (m[2] ?? '').toUpperCase() };
}

async function captureSuccessFactors(cfg: SuccessFactorsConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const feedPath = cfg.feedPath ?? '/sitemap.xml';
  const origin = `https://${cfg.host}`;
  const fixturesDir = join(fixturesRoot, 'nedbank');

  const sfFetch = (url: string): Promise<Response> =>
    fetch(url, { headers: { 'User-Agent': SUCCESSFACTORS_UA } });

  // 1) The feed — one GET carries every open role. Stored verbatim as the
  // single load-bearing ground truth.
  const feedUrl = `${origin}${feedPath}`;
  const feedRes = await sfFetch(feedUrl);
  if (feedRes.status !== 200) {
    console.error(`nedbank feed returned HTTP ${feedRes.status} — feed shape may have drifted.`);
    console.error(`Tried: GET ${feedUrl}`);
    process.exit(1);
  }
  const feedXml = await feedRes.text();
  const items = parseFeed(feedXml);
  if (items.length === 0) {
    console.error('nedbank feed parsed to zero items — parser or feed shape may have drifted.');
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'feed.xml'), feedXml);
  console.log(`Wrote feed.xml (${items.length} items).`);

  // 2) Three detail pages for variety: a Namibia role (country mapping), a
  // Western Cape city and a Gauteng city (city→province mapping). Each proves
  // the datePosted microdata extraction.
  let na: SfFeedItem | undefined;
  let wc: SfFeedItem | undefined;
  let gp: SfFeedItem | undefined;
  for (const item of items) {
    if (na && wc && gp) break;
    const { city, country } = splitSfLocation(item.location);
    if (country === 'NA') {
      na ??= item;
      continue;
    }
    const province = city === '' ? null : normalizeLocation(city).province;
    if (province === 'Western Cape') wc ??= item;
    else if (province === 'Gauteng') gp ??= item;
  }
  const chosen = [na, wc, gp].filter((c): c is SfFeedItem => c !== undefined);
  if (chosen.length < 3) {
    console.error('Could not find all three nedbank fixture varieties (NA / WC / Gauteng).');
    process.exit(1);
  }

  const notes: string[] = [];
  for (let i = 0; i < chosen.length; i += 1) {
    const item = chosen[i];
    if (!item) continue;
    await sleep(delayMs);
    const res = await sfFetch(item.link);
    if (res.status !== 200) throw new Error(`Detail ${item.link} returned HTTP ${res.status}`);
    const html = await res.text();
    writeFileSync(join(fixturesDir, `detail-${i + 1}.html`), html);
    const posted = extractDatePosted(html);
    notes.push(`${item.id} — ${item.title} (${item.location}) datePosted=${posted ?? 'none'}`);
  }

  const manifest = {
    source: 'nedbank',
    capturedAt: new Date().toISOString(),
    ats: 'SAP SuccessFactors Career Site Builder',
    brand: 'Nedbank',
    endpoints: {
      feed: `GET ${feedUrl}`,
      detail: `GET ${origin}/job/{City-Slug-Title}/{numericId}/`,
    },
    totalAtCapture: items.length,
    files: {
      'feed.xml': `The full Google-for-Jobs RSS feed (${items.length} items) — the single load-bearing source.`,
      'detail-1.html': notes[0] ?? '',
      'detail-2.html': notes[1] ?? '',
      'detail-3.html': notes[2] ?? '',
    },
    notes: [
      'The feed lives at /sitemap.xml but is an <rss><channel> Google-for-Jobs feed (g: namespace), NOT a URL sitemap; robots.txt allows /search/, /job/ and /sitemap.xml.',
      'Per item: title, link, guid, g:id (numeric posting id = guid = URL id), g:expiration_date, g:employer, g:job_function, g:location (\"City, CC\"), and a CDATA description of HTML-encoded HTML.',
      'g:id is the SuccessFactors posting id, NOT the internal REQ ID that appears free-text in the body.',
      'id = nedbank:{g:id}; country = uppercased \", CC\" suffix of g:location (\"ZZ\" if absent, never a silent ZA).',
      'The CDATA description is double-encoded (\"&lt;p&gt;\") — decode XML entities once to recover real HTML before sanitizing.',
      'WARNING: the in-body free-text \"Closing date\" is stale and contradicts g:expiration_date (present in only ~11/77 items, one already in the past) — never parse it; we store no expiry (closure is lastSeen-driven).',
      'Description boilerplate is NOT stripped: the leading requisition/recruiter heading label varies wildly across postings, so there is no reliable section boundary to excise without brittle HTML surgery.',
      'postedDate is enriched non-fatally from the detail page datePosted microdata: <meta itemprop=\"datePosted\" content=\"Fri Jul 17 02:00:00 UTC 2026\"> (Java-toString) → YYYY-MM-DD; a miss leaves it null and never drops the job.',
      'Every response mints a fresh JSESSIONID but no request requires sending one back — stay stateless.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1/2/3.html + manifest.json to ${fixturesDir}.`);
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
    case 'gotyme':
      await captureWorkable(GOTYME_WORKABLE_CONFIG);
      return;
    case 'nedbank':
      await captureSuccessFactors(NEDBANK_SF_CONFIG);
      return;
    default:
      console.error(
        `Unknown --source '${source}' (expected absa | firstrand | standardbank | investec | gotyme | nedbank).`,
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
