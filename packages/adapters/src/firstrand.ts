import type { Brand, CanonicalJob, JobLocation } from '@bankjobs/core';
import {
  assertAllowedApplyHost,
  categorize,
  cleanApplyUrl,
  countryCodeFor,
  makeExcerpt,
  normalizeLocation,
  sanitizeDescription,
} from '@bankjobs/core';

import type { FetchOptions, SourceAdapter } from './types';
import { AdapterNormalizeError } from './types';
import type { WorkdayConfig } from './workday/client';
import { fetchAllWorkday } from './workday/client';
import type { WorkdayJobPostingInfo, WorkdayListPosting, WorkdayRawPosting } from './workday/types';

const SOURCE = 'firstrand' as const;

/**
 * FirstRand's Workday tenant. Reuses the shared Workday client verbatim — a new
 * bank on Workday is a new config, not new code. Verified 2026-07-20.
 */
export const FIRSTRAND_WORKDAY_CONFIG: WorkdayConfig = {
  host: 'firstrand.wd3.myworkdayjobs.com',
  tenant: 'firstrand',
  site: 'FRB',
};

/**
 * The sub-brands that carry real attribution value for job seekers. The detail
 * response is useless here — `hiringOrganization` is 'FirstRand Bank Limited'
 * regardless of sub-brand — so the brand is read from the LAST element of the
 * list item's `bulletFields`, which is the franchise label when present.
 * bulletFields are variable-length ([city, country, reqId, brand] or
 * [city, country, reqId, contractType, brand]); the brand is always last.
 */
const SUB_BRANDS: readonly Brand[] = ['FNB', 'RMB', 'WesBank', 'Ashburton', 'DirectAxis'];
const SUB_BRAND_SET = new Set<string>(SUB_BRANDS);

/**
 * Resolve the sub-brand from the list item, falling back to 'FirstRand' (the
 * group) when the last bulletField is not a recognized franchise.
 */
function resolveBrand(listItem: WorkdayListPosting | undefined): Brand {
  const fields = listItem?.bulletFields ?? [];
  const last = fields[fields.length - 1];
  if (last !== undefined && SUB_BRAND_SET.has(last)) return last as Brand;
  return 'FirstRand';
}

/** Best-effort identifier for error messages when the id itself is unusable. */
function rawIdentifier(raw: WorkdayRawPosting): string {
  const info = raw.detail?.jobPostingInfo;
  return info?.jobPostingId ?? info?.id ?? raw.listItem?.externalPath ?? info?.title ?? 'unknown';
}

/** Ordered, de-duplicated raw location strings (primary first). */
function collectRawLocations(info: WorkdayJobPostingInfo): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined): void => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  push(info.location);
  for (const extra of info.additionalLocations ?? []) push(extra);
  return out;
}

export const firstrandAdapter: SourceAdapter<WorkdayRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<WorkdayRawPosting[]> {
    return fetchAllWorkday(FIRSTRAND_WORKDAY_CONFIG, opts);
  },

  normalize(raw: WorkdayRawPosting): CanonicalJob {
    const info = raw.detail?.jobPostingInfo;
    if (!info) {
      throw new AdapterNormalizeError(SOURCE, rawIdentifier(raw), 'missing jobPostingInfo');
    }

    const jobReqId = info.jobReqId;
    if (!jobReqId || jobReqId.trim() === '') {
      throw new AdapterNormalizeError(SOURCE, rawIdentifier(raw), 'missing jobReqId');
    }

    const externalUrl = info.externalUrl;
    if (!externalUrl || externalUrl.trim() === '') {
      throw new AdapterNormalizeError(SOURCE, `${SOURCE}:${jobReqId}`, 'missing externalUrl');
    }

    const title = (info.title ?? '').trim();
    const { html, text } = sanitizeDescription(info.jobDescription ?? '');

    const normalized = collectRawLocations(info).map((r) => normalizeLocation(r));
    const locations: JobLocation[] = normalized.map((n) => ({
      city: n.city,
      province: n.province,
      raw: n.raw,
    }));

    const first = normalized[0];
    const primaryLocation =
      first === undefined
        ? null
        : first.city !== null && first.province !== null
          ? `${first.city}, ${first.province}`
          : first.raw;

    return {
      id: `${SOURCE}:${jobReqId}`,
      source: SOURCE,
      brand: resolveBrand(raw.listItem),
      title,
      category: categorize(title, SOURCE),
      employmentType: info.timeType ?? null,
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      // Same reasoning as Absa: this is an SA careers site, so a posting with no
      // country descriptor defaults to ZA rather than 'International — ZZ'. A
      // present-but-unrecognized descriptor still maps to ZZ.
      country: info.country?.descriptor ? countryCodeFor(info.country.descriptor) : 'ZA',
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(externalUrl)),
      // startDate is the ISO posted date; NEVER the relative postedOn text.
      postedDate: info.startDate ?? null,
    };
  },
};
