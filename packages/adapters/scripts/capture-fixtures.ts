/**
 * Re-capture the committed Absa Workday fixtures from the LIVE endpoint.
 *   pnpm --filter @bankjobs/adapters run capture
 *
 * This talks to the network. It re-verifies the list endpoint first; if the
 * site name has drifted it prints probing instructions and exits non-zero
 * rather than writing garbage over the ground-truth fixtures. Do not run this
 * in CI or tests — the tests read the committed fixtures offline.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ABSA_WORKDAY_CONFIG } from '../src/absa';
import { BROWSER_UA, HONEST_UA } from '../src/workday/client';
import type { WorkdayJobDetail, WorkdayListResponse } from '../src/workday/types';

const cfg = ABSA_WORKDAY_CONFIG;
const pageSize = cfg.pageSize ?? 20;
const delayMs = cfg.delayMs ?? 400;

// Resolve fixtures dir relative to THIS script: scripts/ -> package -> packages -> repo root.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, '../../../fixtures/absa');

const listUrl = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}/jobs`;
const detailBase = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}`;

// Mirror the client's User-Agent policy: honest first, fall back once to a
// browser UA on 406, then reuse whatever worked for the rest of the run.
let resolvedUa: string | undefined;

function withUserAgent(init: RequestInit, ua: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), 'User-Agent': ua },
  };
}

async function wdFetch(url: string, init: RequestInit): Promise<Response> {
  if (resolvedUa !== undefined) {
    return fetch(url, withUserAgent(init, resolvedUa));
  }
  const res = await fetch(url, withUserAgent(init, HONEST_UA));
  if (res.status === 406) {
    resolvedUa = BROWSER_UA;
    return fetch(url, withUserAgent(init, BROWSER_UA));
  }
  resolvedUa = HONEST_UA;
  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simple title heuristic to pick an "IT-ish" posting for variety.
const IT_TITLE_RE =
  /\b(analyst|developer|engineer|software|data|it|technolog|solution|architect|devops|programmer|cyber|digital)\b/i;

interface Captured {
  detail: WorkdayJobDetail;
  text: string;
}

async function fetchDetail(externalPath: string): Promise<Captured> {
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

function fileNote(c: Captured, tag: string): string {
  const info = c.detail.jobPostingInfo;
  return `${info.jobReqId} — ${info.title}, ${info.location} (${tag})`;
}

async function main(): Promise<void> {
  // 1) Re-verify the list endpoint.
  const listRes = await wdFetch(listUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: pageSize, offset: 0, searchText: '' }),
  });

  if (listRes.status !== 200) {
    console.error(
      `Absa list endpoint returned HTTP ${listRes.status} — the site name may have drifted.`,
    );
    console.error(`Tried: POST ${listUrl}`);
    console.error('Probe candidate site names by POSTing to:');
    console.error(`  https://${cfg.host}/wday/cxs/${cfg.tenant}/{SITE}/jobs`);
    console.error(
      '  candidate {SITE} values: ABSAcareersite, Absa, AbsaCareers, External, careers, Careers',
    );
    console.error('Then update ABSA_WORKDAY_CONFIG.site in packages/adapters/src/absa.ts.');
    process.exit(1);
  }

  const listText = await listRes.text();
  const list = JSON.parse(listText) as WorkdayListResponse;
  writeFileSync(join(fixturesDir, 'list-page1.json'), listText);
  console.log(`Wrote list-page1.json (${list.jobPostings.length} postings, total ${list.total}).`);

  // 2) Walk postings, fetching details until we have one of each variety:
  //    a SA non-IT role, an IT-ish role, and a non-SA role.
  let saNonIt: Captured | undefined;
  let itish: Captured | undefined;
  let nonSa: Captured | undefined;

  for (const posting of list.jobPostings) {
    if (saNonIt && itish && nonSa) break;
    const captured = await fetchDetail(posting.externalPath);
    const info = captured.detail.jobPostingInfo;
    const isSa = (info.country?.descriptor ?? '') === 'South Africa';
    const isIt = IT_TITLE_RE.test(info.title);

    if (!isSa) {
      if (!nonSa) nonSa = captured;
    } else if (isIt) {
      if (!itish) itish = captured;
    } else {
      if (!saNonIt) saNonIt = captured;
    }
  }

  if (!saNonIt || !itish || !nonSa) {
    console.error('Could not find all three fixture varieties on page 1:');
    console.error(`  SA non-IT: ${saNonIt ? 'ok' : 'MISSING'}`);
    console.error(`  IT-ish:    ${itish ? 'ok' : 'MISSING'}`);
    console.error(`  non-SA:    ${nonSa ? 'ok' : 'MISSING'}`);
    console.error(
      'Widen the search (fetch a second page) or relax the IT title keywords, then re-run.',
    );
    process.exit(1);
  }

  writeFileSync(join(fixturesDir, 'detail-1.json'), saNonIt.text);
  writeFileSync(join(fixturesDir, 'detail-2.json'), itish.text);
  writeFileSync(join(fixturesDir, 'detail-3.json'), nonSa.text);

  // 3) Manifest — timestamp, endpoints, total, file descriptions, and the notes
  //    that document the endpoint gotchas.
  const manifest = {
    source: 'absa',
    capturedAt: new Date().toISOString(),
    endpoints: {
      list: `POST ${listUrl}`,
      detail: `GET ${detailBase}{externalPath}`,
    },
    totalAtCapture: list.total,
    files: {
      'list-page1.json': `First list page, limit ${pageSize}, offset 0`,
      'detail-1.json': fileNote(saNonIt, 'SA non-IT'),
      'detail-2.json': fileNote(itish, 'IT-ish'),
      'detail-3.json': fileNote(nonSa, 'non-ZA test case'),
    },
    notes: [
      'Workday returns 406 for non-browser User-Agents; captured with a Chrome UA + Accept: application/json.',
      'jobPostingInfo.country is an object {descriptor, id}, not a string — map descriptor to ISO alpha-2.',
      'jobPostingInfo.startDate is the ISO posted date; postedOn is relative text and must not be used.',
      'Page size caps at 20 regardless of requested limit.',
    ],
  };
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote detail-1/2/3.json + manifest.json to ${fixturesDir}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
