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
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { EARCU_UA, extractDetailUrls, extractJobPostingLd } from '../src/earcu/client';
import type { EarcuConfig } from '../src/earcu/client';
import type { EarcuJobPosting } from '../src/earcu/types';
import { NEDBANK_SF_CONFIG } from '../src/nedbank';
import { DISCOVERY_SF_CONFIG } from '../src/discovery';
import { CAPITEC_SF_CONFIG } from '../src/capitec';
import { SARB_ORACLE_CONFIG } from '../src/sarb';
import { ORACLE_UA } from '../src/oracle/client';
import type { OracleConfig } from '../src/oracle/client';
import type { OracleListResponse, OracleDetailResponse } from '../src/oracle/types';
import {
  SUCCESSFACTORS_UA,
  extractDatePosted,
  parseFeed,
  parseSitemap,
  parseSitemapDetail,
} from '../src/successfactors/client';
import type { SuccessFactorsConfig } from '../src/successfactors/client';
import type { SfFeedItem, SfSitemapPosting } from '../src/successfactors/types';
import { POSTBANK_SITE_CONFIG } from '../src/postbank';
import {
  POSTBANK_UA,
  advertHtmlFromPdf,
  careersUrl,
  parseVacancies,
  partitionByClosingDate,
  sastDate,
} from '../src/postbank/client';
import type { PostbankConfig } from '../src/postbank/client';
import type { PostbankVacancy } from '../src/postbank/types';

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
  const sitemapPath = cfg.sitemapPath ?? '/jobs/sitemap.xml';
  const origin = `https://${cfg.host}`;
  const fixturesDir = join(fixturesRoot, 'investec');

  const eaFetch = (url: string): Promise<Response> =>
    fetch(url, { headers: { 'User-Agent': EARCU_UA } });

  /** A WAF-aware status report (a challenge is a 202 with an empty body). */
  const statusNote = (res: Response): string => {
    const waf = res.headers.get('x-amzn-waf-action');
    return waf ? `HTTP ${res.status} (x-amzn-waf-action: ${waf})` : `HTTP ${res.status}`;
  };

  // 1) The URL sitemap — one GET enumerates every vacancy. Stored verbatim as
  // ground truth (it also pins the talentpool entries the parser must exclude).
  const sitemapUrl = `${origin}${sitemapPath}`;
  const sitemapRes = await eaFetch(sitemapUrl);
  if (sitemapRes.status !== 200) {
    console.error(`investec sitemap returned ${statusNote(sitemapRes)}.`);
    console.error(`Tried: GET ${sitemapUrl}`);
    process.exit(1);
  }
  const sitemapXml = await sitemapRes.text();
  const detailUrls = extractDetailUrls(sitemapXml, origin);
  if (detailUrls.length === 0) {
    console.error(
      'investec sitemap parsed to zero vacancy URLs — parser or shape may have drifted.',
    );
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'sitemap.xml'), sitemapXml);
  const locCount = (sitemapXml.match(/<loc>/gi) ?? []).length;
  console.log(`Wrote sitemap.xml (${detailUrls.length} vacancies of ${locCount} <loc> entries).`);

  // 2) detail pages → full HTML. Pick three for variety: a Western Cape city, a
  // Gauteng city, and a posting whose JSON-LD address is empty (city lives in
  // the title only) to exercise the no-location branch.
  let wc, gp, noLoc;
  for (const url of detailUrls) {
    if (wc && gp && noLoc) break;
    await sleep(delayMs);
    const res = await eaFetch(url);
    if (res.status !== 200) throw new Error(`Detail ${url} returned ${statusNote(res)}`);
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
      sitemap: `GET ${sitemapUrl}`,
      detail: `GET ${origin}/jobs/vacancy/{slug}/{id}/description/`,
    },
    totalAtCapture: detailUrls.length,
    locsAtCapture: locCount,
    files: {
      'sitemap.xml': `The full URL sitemap (${locCount} <loc> entries, ${detailUrls.length} vacancies) — the enumeration source.`,
      'detail-1.html': fileNoteEarcu(wc),
      'detail-2.html': fileNoteEarcu(gp),
      'detail-3.html': fileNoteEarcu(noLoc),
    },
    notes: [
      'Corporate www.investec.com is behind Cloudflare Turnstile and 403s bots — NEVER fetch it; only careers.investec.co.za is used.',
      'DISCOVERY MOVED TO THE SITEMAP (2026-07-28). Since ~midday SAST 2026-07-27 the eArcu search-results page /jobs/vacancy/find/results/ — and therefore the posbrowser_gridhandler AJAX endpoint that needs its per-load pagestamp + session cookies — sits behind an AWS WAF JavaScript challenge: it answers HTTP 202 with header "x-amzn-waf-action: challenge" and an EMPTY body for any client that does not execute the challenge JS. It is not UA-based (browser UA strings are challenged too) and not intermittent. 202 is a 2xx, so the old res.ok check waved it through and the run died at pagestamp extraction — the client now requires status === 200 everywhere and names the WAF header in the error.',
      'The sitemap (GET /jobs/sitemap.xml) and the detail pages are NOT challenged — 200, full body, cookie-free, honest UA.',
      'The sitemap <urlset> mixes three kinds of <loc>: /jobs/vacancy/{slug}/{id}/description/ (the real vacancies), /jobs/talentpool/{slug}/{id}/description/ (evergreen talent pools — NOT jobs, always EXCLUDED) and a handful of ordinary site pages. Talent pools outnumber vacancies roughly 7:1, so the vacancy-path filter is load-bearing. Each url also carries <changefreq>daily</changefreq> and a <lastmod> date (unused: it tracks page regeneration, not posting date).',
      'robots.txt on careers.investec.co.za disallows only /file/*; its "Sitemap:" line points at the UK host (careers.investec.co.uk/jobs/sitemap.xml) — a copy-paste quirk. The ZA path equivalent exists and is what we fetch.',
      'Detail pages are stable and cookie-free; each embeds ONE application/ld+json JobPosting block.',
      'id = investec:{identifier.value} (identifier is a PropertyValue object; value is the req number). NOTE the req number in the slug is NOT the numeric id in the URL path (slug ...-13385-cape-town, path /13403/) — ids always come from the JSON-LD identifier, never the URL.',
      'datePosted is templated to today (untrusted) and validThrough is unreliable — postedDate is set null.',
      'applyUrl is the detail-page URL itself (the /action/apply/?pagestamp=... link is session-bound).',
      'addressCountry is a display name (South Africa) — map via countryCodeFor. A city-less posting has TWO live shapes: an empty jobLocation array (13784, committed as detail-3) or a Place holding an empty PostalAddress (12158 on capture day, covered by a unit test). Both fall through to no location + country ZA; the city named in the slug is never mined.',
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

// ---------------------------------------------------------------------------
// SuccessFactors CSB, SITEMAP path (discovery). Group-wide site: crawl every
// job the sitemap enumerates, tally group vs bank, and capture a handful of
// detail pages that MUST include at least one Discovery Bank role AND at least
// one non-bank role (the client-side filter needs a real negative case).
// ---------------------------------------------------------------------------

interface SfCaptured {
  url: string;
  html: string;
  posting: SfSitemapPosting;
}

async function captureSuccessFactorsSitemap(cfg: SuccessFactorsConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const sitemapPath = cfg.sitemapPath ?? '/sitemap.xml';
  const origin = `https://${cfg.host}`;
  const fixturesDir = join(fixturesRoot, 'discovery');

  const sfFetch = (url: string): Promise<Response> =>
    fetch(url, { headers: { 'User-Agent': SUCCESSFACTORS_UA } });

  // 1) The URL sitemap — one GET enumerates every open role. Stored verbatim.
  const sitemapUrl = `${origin}${sitemapPath}`;
  const sitemapRes = await sfFetch(sitemapUrl);
  if (sitemapRes.status !== 200) {
    console.error(`discovery sitemap returned HTTP ${sitemapRes.status} — shape may have drifted.`);
    console.error(`Tried: GET ${sitemapUrl}`);
    process.exit(1);
  }
  const sitemapXml = await sitemapRes.text();
  const urls = parseSitemap(sitemapXml);
  if (urls.length === 0) {
    console.error('discovery sitemap parsed to zero job URLs — parser or shape may have drifted.');
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'sitemap.xml'), sitemapXml);
  console.log(`Wrote sitemap.xml (${urls.length} job URLs).`);

  // 2) Crawl every detail page: tally group vs bank and pick the fixture variety
  //    (2 bank roles for the kept case + category spread, 2 non-bank for the
  //    dropped case + KZN/EC location spread, backfilled from any non-bank).
  const BANK = 'Discovery Bank';
  const banks: SfCaptured[] = [];
  const nonBanks: SfCaptured[] = [];
  let nonBankKZN: SfCaptured | undefined;
  let nonBankEC: SfCaptured | undefined;
  let skipped = 0;

  for (const url of urls) {
    await sleep(delayMs);
    const res = await sfFetch(url);
    if (res.status !== 200) {
      skipped += 1;
      console.warn(`  skip ${url} — HTTP ${res.status}`);
      continue;
    }
    const html = await res.text();
    const posting = parseSitemapDetail(html, url);
    if (posting === null) {
      skipped += 1;
      console.warn(`  skip ${url} — missing critical field (jobId/title)`);
      continue;
    }
    const captured: SfCaptured = { url, html, posting };
    if (posting.businessUnit.trim() === BANK) {
      banks.push(captured);
    } else {
      nonBanks.push(captured);
      const province = posting.locality ? normalizeLocation(posting.locality).province : null;
      if (province === 'KwaZulu-Natal') nonBankKZN ??= captured;
      else if (province === 'Eastern Cape') nonBankEC ??= captured;
    }
  }

  console.log(
    `Crawled ${urls.length} URLs: ${banks.length} ${BANK}, ${nonBanks.length} other-brand, ${skipped} skipped.`,
  );
  if (banks.length === 0 || nonBanks.length === 0) {
    console.error(
      `Need at least one ${BANK} role AND one non-bank role for fixtures ` +
        `(got ${banks.length} bank, ${nonBanks.length} non-bank).`,
    );
    process.exit(1);
  }

  // detail-1/2 = bank; detail-3/4 = non-bank (prefer KZN then EC, backfill any).
  const nonBankPicks: SfCaptured[] = [];
  for (const c of [nonBankKZN, nonBankEC, ...nonBanks]) {
    if (c && !nonBankPicks.includes(c)) nonBankPicks.push(c);
    if (nonBankPicks.length === 2) break;
  }
  const chosen: SfCaptured[] = [...banks.slice(0, 2), ...nonBankPicks];

  const files: Record<string, string> = {
    'sitemap.xml': `The full URL sitemap (${urls.length} job URLs) — the enumeration source.`,
  };
  chosen.forEach((c, i) => {
    writeFileSync(join(fixturesDir, `detail-${i + 1}.html`), c.html);
    const p = c.posting;
    files[`detail-${i + 1}.html`] =
      `${p.jobId} — ${p.title} [${p.businessUnit}] (${p.locality}, ${p.country}) ` +
      `datePosted=${p.postedDate ?? 'none'}`;
  });

  const manifest = {
    source: 'discovery',
    capturedAt: new Date().toISOString(),
    ats: 'SAP SuccessFactors Career Site Builder (group-wide)',
    brand: BANK,
    endpoints: {
      sitemap: `GET ${sitemapUrl}`,
      detail: `GET ${origin}/job/{City-Slug-Title}/{numericId}/`,
    },
    totalAtCapture: urls.length,
    bankAtCapture: banks.length,
    otherBrandAtCapture: nonBanks.length,
    files,
    notes: [
      'careers.discovery.co.za is a GROUP-WIDE CSB site (all Discovery Limited brands); /sitemap.xml here is a REAL <urlset> of job detail URLs, NOT the Google-for-Jobs RSS Nedbank serves at that path.',
      "Server-side filtering (?customfield1=…) is IGNORED — crawl everything and filter client-side to Business Unit == 'Discovery Bank'.",
      'Detail pages are LOAD-BEARING: title/businessUnit/function come from the labelled data-careersite-propertyid fields (customfield1 = Business Unit is ONLY exposed there); address/date come from schema.org itemprop microdata.',
      'datePosted microdata is Java-toString ("Thu Jul 16 00:00:00 UTC 2026") → YYYY-MM-DD; addressCountry is an ISO alpha-2 code ("ZA") directly, addressLocality combines suburb + building ("Sandton - 1 Discovery Place").',
      'validThrough microdata exists but is IGNORED (closure is lastSeen-driven; no expiry stored).',
      'robots.txt disallows /talentcommunity/, /services/, /preapply/, /applybutton/; /sitemap.xml and /job/ are allowed. The capped RSS under /services/ and the apply flow /talentcommunity/apply/{jobId}/ are NEVER fetched.',
      'applyUrl = the public /job/ detail page: the real apply route /talentcommunity/apply/{jobId}/ is robots-disallowed and session-bound.',
      'Fixtures include non-bank roles on purpose — the Discovery-Bank filter needs a real negative case; the ingest fixtures loader drops them exactly as fetchAll does.',
      'Every response mints a fresh JSESSIONID but no request requires sending one back — stay stateless.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1..${chosen.length}.html + manifest.json to ${fixturesDir}.`);
}

// ---------------------------------------------------------------------------
// SuccessFactors CSB, SITEMAP path (capitec). SINGLE-BRAND site: crawl every job
// the sitemap enumerates (no business-unit split) and capture four detail pages
// spanning the two address shapes and the notable role types — a streetAddress-
// located corporate/IT role, a structured-address Sales banker (city→province),
// a bare-"ZA" locationless pipeline banker, and a graduate/internship programme.
// ---------------------------------------------------------------------------

interface CapCaptured {
  url: string;
  html: string;
  posting: SfSitemapPosting;
  structured: boolean;
}

async function captureCapitecSitemap(cfg: SuccessFactorsConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const sitemapPath = cfg.sitemapPath ?? '/sitemap.xml';
  const origin = `https://${cfg.host}`;
  const fixturesDir = join(fixturesRoot, 'capitec');

  const sfFetch = (url: string): Promise<Response> =>
    fetch(url, { headers: { 'User-Agent': SUCCESSFACTORS_UA } });

  // 1) The URL sitemap — one GET enumerates every open role. Stored verbatim.
  const sitemapUrl = `${origin}${sitemapPath}`;
  const sitemapRes = await sfFetch(sitemapUrl);
  if (sitemapRes.status !== 200) {
    console.error(`capitec sitemap returned HTTP ${sitemapRes.status} — shape may have drifted.`);
    console.error(`Tried: GET ${sitemapUrl}`);
    process.exit(1);
  }
  const sitemapXml = await sitemapRes.text();
  const urls = parseSitemap(sitemapXml);
  if (urls.length === 0) {
    console.error('capitec sitemap parsed to zero job URLs — parser or shape may have drifted.');
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'sitemap.xml'), sitemapXml);
  console.log(`Wrote sitemap.xml (${urls.length} job URLs).`);

  // 2) Crawl detail pages until the four fixture varieties are found.
  let streetCorporate: CapCaptured | undefined;
  let structuredBanker: CapCaptured | undefined;
  let pipelineBare: CapCaptured | undefined;
  let graduate: CapCaptured | undefined;
  let skipped = 0;

  for (const url of urls) {
    if (streetCorporate && structuredBanker && pipelineBare && graduate) break;
    await sleep(delayMs);
    const res = await sfFetch(url);
    if (res.status !== 200) {
      skipped += 1;
      console.warn(`  skip ${url} — HTTP ${res.status}`);
      continue;
    }
    const html = await res.text();
    const posting = parseSitemapDetail(html, url);
    if (posting === null) {
      skipped += 1;
      console.warn(`  skip ${url} — missing critical field (jobId/title)`);
      continue;
    }
    // The structured-address shape carries an addressLocality meta; the common
    // shape carries only a streetAddress.
    const structured = /itemprop=["']addressLocality["']/i.test(html);
    const captured: CapCaptured = { url, html, posting, structured };
    const title = posting.title;
    const isBanker = /banker/i.test(title);
    const isGraduate = /(graduate|internship)\s+programme/i.test(title);
    const locationless = posting.locality.trim() === '';

    if (isGraduate) {
      graduate ??= captured;
    } else if (locationless && isBanker) {
      pipelineBare ??= captured;
    } else if (structured && isBanker) {
      structuredBanker ??= captured;
    } else if (
      !isBanker &&
      !locationless &&
      !structured &&
      /\b(data|software|engineer|developer)\b/i.test(title)
    ) {
      // A representative corporate tech role (Capitec's inventory skews this way).
      streetCorporate ??= captured;
    }
  }

  const chosen = [streetCorporate, structuredBanker, pipelineBare, graduate].filter(
    (c): c is CapCaptured => c !== undefined,
  );
  if (chosen.length < 4) {
    console.error(
      `Could not find all four capitec fixture varieties on the sitemap (got ${chosen.length}: ` +
        `streetCorporate=${Boolean(streetCorporate)} structuredBanker=${Boolean(structuredBanker)} ` +
        `pipelineBare=${Boolean(pipelineBare)} graduate=${Boolean(graduate)}).`,
    );
    process.exit(1);
  }
  console.log(`Selected 4 fixtures (${skipped} pages skipped while scanning).`);

  const files: Record<string, string> = {
    'sitemap.xml': `The full URL sitemap (${urls.length} job URLs) — the enumeration source.`,
  };
  const tags = [
    'streetAddress corporate/IT',
    'structured-address Sales banker',
    'bare-"ZA" pipeline banker',
    'graduate/internship programme',
  ];
  chosen.forEach((c, i) => {
    writeFileSync(join(fixturesDir, `detail-${i + 1}.html`), c.html);
    const p = c.posting;
    files[`detail-${i + 1}.html`] =
      `${p.jobId} — ${p.title} (${p.locality || 'no city'}, ${p.country}) ` +
      `[${c.structured ? 'structured' : 'streetAddress'}] datePosted=${p.postedDate ?? 'none'} — ${tags[i]}`;
  });

  const manifest = {
    source: 'capitec',
    capturedAt: new Date().toISOString(),
    ats: 'SAP SuccessFactors Career Site Builder (single-brand)',
    brand: 'Capitec',
    endpoints: {
      sitemap: `GET ${sitemapUrl}`,
      detail: `GET ${origin}/job/{City-Slug-Title}/{numericId}/`,
    },
    totalAtCapture: urls.length,
    files,
    notes: [
      'careers.capitecbank.co.za is a SINGLE-BRAND CSB site (every posting is Capitec — no business-unit filter); /sitemap.xml here is a REAL <urlset> of job detail URLs, like Discovery and NOT the Google-for-Jobs RSS Nedbank serves at that path.',
      'Detail pages are LOAD-BEARING: unlike Discovery, the title is schema.org ELEMENT microdata (<h1 itemprop="title">…</h1>), NOT a labelled data-careersite-propertyid span, and there are NO business-unit/function labelled spans (single brand), so both resolve to empty.',
      'Address microdata has two shapes: a single <meta itemprop="streetAddress" content="City, ZA"> (most roles; a bare "ZA" for nationwide/pipeline roles with no city), OR structured addressLocality/addressRegion/addressCountry (some roles, e.g. branch/business-banker). The shared client parser tolerates both; country is the ISO alpha-2 code directly.',
      'datePosted microdata is Java-toString ("Tue Jul 14 00:00:00 UTC 2026") → YYYY-MM-DD; validThrough (~19-day window) exists but is IGNORED (closure is lastSeen-driven; no expiry stored).',
      'robots.txt disallows /talentcommunity/, /services/, /preapply/, /applybutton/, /emailsubscribe/, etc.; /sitemap.xml, /job/, /search/, /viewalljobs/ are allowed. The apply flow under /talentcommunity/ and the analytics beacon /services/t/l are NEVER fetched.',
      'applyUrl = the public /job/ detail page: the real apply route is robots-disallowed and session-bound.',
      'NEVER fetch www.capitecbank.co.za — the marketing site is Cloudflare-challenge protected (403). Only the careers subdomain is used, and it is unprotected.',
      'Server-templated listing pages exist (/search/?startrow=N, 25/page) but are NOT used: overrunning startrow yields a garbage "Results 76–10 of 10" page that reprints page 1 — the sitemap supersedes them.',
      'Every response mints a fresh JSESSIONID but no request requires sending one back — stay stateless.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1..${chosen.length}.html + manifest.json to ${fixturesDir}.`);
}

// ---------------------------------------------------------------------------
// Oracle Recruiting Cloud (Fusion HCM Candidate Experience) source (sarb).
// A JSON list+detail API: one list page carries the whole (small) inventory,
// each detail is a per-req GET. Capture three fixtures for variety — the generic
// bare-"South Africa"/IT role (locationless case), a Policy & Regulation analyst
// (the per-source Risk & Compliance rule) and an Administration role (the
// per-source Operations & Admin rule).
// ---------------------------------------------------------------------------

async function captureOracle(cfg: OracleConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const fixturesDir = join(fixturesRoot, 'sarb');
  const restBase = `https://${cfg.host}/hcmRestApi/resources/latest`;

  const orFetch = (url: string): Promise<Response> =>
    fetch(url, { headers: { 'User-Agent': ORACLE_UA, Accept: 'application/json' } });

  const listUrl =
    `${restBase}/recruitingCEJobRequisitions?onlyData=true` +
    `&expand=requisitionList.workLocation` +
    `&finder=findReqs;siteNumber=${cfg.siteNumber},limit=200,offset=0,sortBy=POSTING_DATES_DESC`;
  const detailUrl = (id: string): string =>
    `${restBase}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true` +
    `&finder=ById;Id="${id}",siteNumber=${cfg.siteNumber}`;

  // 1) The list — one GET carries the whole inventory. Stored verbatim.
  const listRes = await orFetch(listUrl);
  if (listRes.status !== 200) {
    console.error(`sarb list endpoint returned HTTP ${listRes.status} — shape may have drifted.`);
    console.error(`Tried: GET ${listUrl}`);
    process.exit(1);
  }
  const listText = await listRes.text();
  const list = JSON.parse(listText) as OracleListResponse;
  const container = list.items[0];
  const requisitions = container?.requisitionList;
  if (!requisitions) {
    console.error(
      "sarb list carried no 'requisitionList' key — the expand param was dropped or the shape drifted.",
    );
    process.exit(1);
  }
  writeFileSync(join(fixturesDir, 'list-page1.json'), listText);
  console.log(
    `Wrote list-page1.json (${requisitions.length} requisitions, total ${container?.TotalJobsCount ?? '?'}).`,
  );

  // 2) Scan requisitions, fetching each detail, until the three varieties are
  // found. A bare-country PrimaryLocation (no comma) marks the locationless role.
  async function fetchDetail(
    id: string,
  ): Promise<{ detail: OracleDetailResponse['items'][number]; text: string }> {
    await sleep(delayMs);
    const res = await orFetch(detailUrl(id));
    if (res.status !== 200) throw new Error(`Detail request for ${id} returned HTTP ${res.status}`);
    const text = await res.text();
    const parsed = JSON.parse(text) as OracleDetailResponse;
    const detail = parsed.items[0];
    if (!detail) throw new Error(`Detail ${id} had no items[0]`);
    return { detail, text };
  }

  let genericSa: { detail: OracleDetailResponse['items'][number]; text: string } | undefined;
  let policy: { detail: OracleDetailResponse['items'][number]; text: string } | undefined;
  let admin: { detail: OracleDetailResponse['items'][number]; text: string } | undefined;
  for (const req of requisitions) {
    if (genericSa && policy && admin) break;
    const captured = await fetchDetail(req.Id);
    const d = captured.detail;
    const bareCountry =
      (d.PrimaryLocation ?? '').trim() !== '' && !(d.PrimaryLocation ?? '').includes(',');
    const category = d.Category ?? '';
    const title = d.Title ?? '';
    if (bareCountry) genericSa ??= captured;
    else if (/policy|regulation/i.test(category)) policy ??= captured;
    // The admin slot targets the Personal Assistant specifically — it is the one
    // role that exercises the per-source Operations & Admin rule (other admin
    // titles carry Administrator/Coordinator, matched by the global rules).
    else if (/personal assistant/i.test(title)) admin ??= captured;
  }

  const chosen = [genericSa, policy, admin].filter(
    (c): c is { detail: OracleDetailResponse['items'][number]; text: string } => c !== undefined,
  );
  if (chosen.length < 3) {
    console.error(
      `Could not find all three sarb fixture varieties (generic-SA=${Boolean(genericSa)} ` +
        `policy=${Boolean(policy)} admin=${Boolean(admin)}).`,
    );
    process.exit(1);
  }

  const tags = ['generic bare-"South Africa"/IT', 'Policy & Regulation analyst', 'Administration'];
  const files: Record<string, string> = {
    'list-page1.json': `Full list (${requisitions.length} requisitions, expand=requisitionList.workLocation).`,
  };
  chosen.forEach((c, i) => {
    writeFileSync(join(fixturesDir, `detail-${i + 1}.json`), c.text);
    const d = c.detail;
    const wl = d.workLocation?.[0];
    files[`detail-${i + 1}.json`] =
      `${d.Id} — ${d.Title} [${d.Category}] (${d.PrimaryLocation}; workLocation ` +
      `${wl?.TownOrCity ?? 'none'}, ${wl?.Country ?? '?'}) JobSchedule=${d.JobSchedule ?? 'null'} — ${tags[i]}`;
  });

  const manifest = {
    source: 'sarb',
    capturedAt: new Date().toISOString(),
    ats: 'Oracle Recruiting Cloud (Fusion HCM Candidate Experience), REST 11.13.18.05',
    brand: 'SARB',
    site: `slug 'SARB' aliases internal siteNumber ${cfg.siteNumber} — byte-identical requisition sets`,
    endpoints: {
      list: `GET ${restBase}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation&finder=findReqs;siteNumber=${cfg.siteNumber},limit=N,offset=N,sortBy=POSTING_DATES_DESC`,
      detail: `GET ${restBase}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="{Id}",siteNumber=${cfg.siteNumber}`,
      jobPage: `https://${cfg.host}/hcmUI/CandidateExperience/en/sites/${cfg.uiSite}/job/{Id}`,
    },
    totalAtCapture: container?.TotalJobsCount ?? requisitions.length,
    files,
    notes: [
      'Public CE REST API, no auth, honest UA gets 200; response Content-Type is application/vnd.oracle.adf.resourcecollection+json (still JSON — never gate on the MIME type).',
      'CRITICAL: omit expand=requisitionList.workLocation and the list still returns 200 with facets but NO requisitionList key at all (absent, not empty) — the client asserts the key and throws, never treating it as zero jobs.',
      'HEAD requests 501 — this is a GET-only API. Offset paging is verified gapless; limit up to 200 is honored. Paginate by TotalJobsCount with a SAFETY_CAP.',
      'ID discipline: Id (e.g. "1736") is the human req number used in all public URLs and is the adapter key (sarb:1736); the huge internal RequisitionId surrogate is ignored. Keep the finder Id QUOTED (Oracle convention; other ORC tenants reject the unquoted form).',
      'Titles echo the req number as a leading "(1736) " prefix; the adapter strips it only when the parenthesised number equals the Id (interior parens like "(3 Year Contract)" are kept).',
      'Location: SARB runs one physical site (Pretoria Head Office), so every workLocation[] carries Pretoria even for a role advertised nationwide. The requisition PrimaryLocation is the candidate-facing signal — "City, Country" (located) vs a bare country ("South Africa", nationwide → locationless, country ZA, no invented city).',
      'ExternalPostedStartDate is the real full ISO posted timestamp (date part is canonical, matches the list PostedDate). ExternalPostedEndDate (expiry) exists but is IGNORED — closure is lastSeen-driven, no expiry stored.',
      'applyUrl = the stable public job page /sites/SARB/job/{Id}; that page is a JS shell (OpenGraph tags only, no JSON-LD), so the REST API is the sole data path.',
      'NEVER fetch www.resbank.co.za — an F5-style WAF blocks non-browser traffic; it is irrelevant to the adapter.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1/2/3.json + manifest.json to ${fixturesDir}.`);
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
// Postbank — no ATS at all. One hand-maintained HTML table, one PDF advert per
// row. Capture the listing verbatim plus a small set of adverts: EVERY row that
// is still open on capture day (those are what an offline ingest run replays)
// and two long-expired ones, kept deliberately so the closing-date filter has
// real negatives to be tested against.
// ---------------------------------------------------------------------------

/** Expired rows worth committing, by advert slug: the shapes worth pinning. */
const POSTBANK_EXPIRED_FIXTURES: readonly string[] = [
  // Frontline in-store banking role: a province-only location cell, the
  // 'Minimum Qualifications and Experience Required' heading variant, and a
  // Matric-minimum requirements block (the min-taking safety property).
  'advert-customer-services-clerk-western-cape',
  // Same family, and its href carries the site's stray-space filename quirk
  // ('vacancies\Advert _Team Lead Customer Services Western Cape.pdf') — proof
  // that the percent-encoded URL we build actually resolves.
  'advert-team-lead-customer-services-western-cape',
];

async function capturePostbank(cfg: PostbankConfig): Promise<void> {
  const delayMs = cfg.delayMs ?? 400;
  const fixturesDir = join(fixturesRoot, 'postbank');
  const listUrl = careersUrl(cfg);

  const pbFetch = (url: string, accept: string): Promise<Response> =>
    fetch(url, { headers: { 'User-Agent': POSTBANK_UA, Accept: accept } });

  // 1) The careers page — the enumeration source. Stored verbatim.
  const listRes = await pbFetch(listUrl, 'text/html');
  if (listRes.status !== 200) {
    console.error(
      `postbank careers page returned HTTP ${listRes.status} — shape may have drifted.`,
    );
    console.error(`Tried: GET ${listUrl}`);
    process.exit(1);
  }
  const html = await listRes.text();
  const vacancies = parseVacancies(html, listUrl);
  if (vacancies.length === 0) {
    console.error('postbank careers page parsed to zero vacancy rows — table markup has drifted.');
    process.exit(1);
  }
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, 'careers.html'), html);

  const capturedAt = new Date();
  const today = sastDate(capturedAt);
  const { open, expired, unparsed } = partitionByClosingDate(vacancies, today);
  console.log(
    `Wrote careers.html (${vacancies.length} rows: ${open.length} open on ${today} SAST, ` +
      `${expired.length} expired, ${unparsed.length} unreadable).`,
  );

  // 2) The adverts. Open rows are what an offline run replays; the two pinned
  // expired ones are the filter's negatives.
  const wanted = [
    ...open,
    ...POSTBANK_EXPIRED_FIXTURES.map((slug) => expired.find((v) => v.slug === slug)).filter(
      (v): v is PostbankVacancy => v !== undefined,
    ),
  ];
  if (wanted.length === open.length) {
    console.warn(
      'None of the pinned expired adverts are on the page any more — the filter fixtures are stale.',
    );
  }

  const files: Record<string, string> = {
    'careers.html': `The careers listing verbatim (${vacancies.length} rows, ${open.length} open on ${today} SAST) — the enumeration source and the only page fetched per run.`,
  };

  for (const vacancy of wanted) {
    await sleep(delayMs);
    const res = await pbFetch(vacancy.pdfUrl, 'application/pdf');
    if (res.status !== 200) {
      console.error(`  advert ${vacancy.slug} returned HTTP ${res.status} — skipping.`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    writeFileSync(join(fixturesDir, `${vacancy.slug}.pdf`), bytes);
    const advertHtml = await advertHtmlFromPdf(bytes);
    const state = vacancy.closingDate !== null && vacancy.closingDate >= today ? 'OPEN' : 'EXPIRED';
    files[`${vacancy.slug}.pdf`] =
      `${vacancy.title} (${vacancy.rawLocation}) — closes ${vacancy.closingDateRaw} [${state}]; ` +
      `${advertHtml.length} chars of block HTML extracted`;
    console.log(`  Wrote ${vacancy.slug}.pdf (${bytes.length} bytes, ${state}).`);
  }

  const manifest = {
    source: 'postbank',
    capturedAt: capturedAt.toISOString(),
    ats: 'none — a hand-maintained HTML table linking PDF adverts',
    brand: 'Postbank',
    endpoints: {
      careers: `GET ${listUrl}`,
      advert: `GET https://${cfg.host}/vacancies/{Advert filename}.pdf`,
    },
    totalAtCapture: vacancies.length,
    openAtCapture: open.length,
    expiredAtCapture: expired.length,
    files,
    notes: [
      'No ATS, no API, no JSON: careers.html is a static server-rendered <table> under an <h3>Vacancies</h3> heading, three cells per row (position → PDF advert, location, closing date). The honest UA gets 200 on the page and on every PDF; robots.txt constrains only Googlebot, on unrelated paths.',
      'CLOSED ADS ARE NEVER REMOVED — the table is a rolling archive of everything advertised this year. On capture day 64 rows were listed and only 2 were still open, so the closing-date filter (closing date >= today in SAST, keeping a role that closes today) IS the adapter. A row whose printed date does not parse is dropped and logged, never published.',
      'Hrefs are WINDOWS paths written into the HTML — "vacancies\\Advert_Specialist Architect 2026.pdf" — with raw spaces, and some rows carry en-dashes ("– Electronic Payments"), ampersands ("IT Assets & Risk Officer"), double spaces and a stray space after "Advert". Normalising the backslashes and resolving through the WHATWG URL parser percent-encodes all of it exactly as the server expects.',
      'The PDF advert IS the job ad; the table carries no description at all. The PDFs are text-based (never scans), 1–3 pages, laid out as floating text boxes — so PDF.js content-stream order hoists every section heading to the top of its page. The pdf/ client rebuilds reading order from the item geometry instead, which is what keeps "Minimum Requirements" attached to the qualifications block that core\'s heading-windowed requirements extractor reads.',
      "Advert metadata block: JOB TITLE / JOB GRADING / REPORT(S) TO / BUSINESS UNIT / LOCATION / POSITION STATUS. LOCATION spells out what the table's 'HEAD OFFICE' means ('HEAD OFFICE: PRETORIA'), which is why the adapter resolves that label to Pretoria.",
      'Location cells are free text in CAPS and several list more than one place: "JOHANNESBURG\\BLOEMFONTEIN" (backslash), "WESTERN CAPE AND KWAZULU NATAL X2" (headcount marker), and a six-province list. The adapter splits them; provinces with no city resolve province-only.',
      'No posted date exists anywhere — not on the page, not in the advert — so postedDate is null and the site falls back to firstSeen. The closing date is not stored either (the Job model has no expiry field); closure stays lastSeen-driven, as for every other source.',
      'id = a slug of the PDF FILENAME, the only stable identifier this source has (no requisition numbers anywhere). A re-advertised role gets a new PDF, hence a new id — correct, since it is a new posting with a new closing date.',
      'applyUrl = the advert PDF. There is no application form: each advert names the mailbox to send a CV to, so the PDF is both the ad and the official application channel.',
      'Expired adverts are committed on purpose — the closing-date filter needs real negatives, and the ingest fixtures loader drops them exactly as fetchAll does.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote manifest.json to ${fixturesDir}.`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // pnpm's documented `pnpm run capture -- --source=X` form forwards the
  // literal `--` separator; parseArgs treats it as a positional and rejects it,
  // so strip it before parsing (mirrors ingest/cli.ts).
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args,
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
    case 'discovery':
      await captureSuccessFactorsSitemap(DISCOVERY_SF_CONFIG);
      return;
    case 'capitec':
      await captureCapitecSitemap(CAPITEC_SF_CONFIG);
      return;
    case 'sarb':
      await captureOracle(SARB_ORACLE_CONFIG);
      return;
    case 'postbank':
      await capturePostbank(POSTBANK_SITE_CONFIG);
      return;
    default:
      console.error(
        `Unknown --source '${source}' (expected absa | firstrand | standardbank | investec | gotyme | nedbank | discovery | capitec | postbank | sarb).`,
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
