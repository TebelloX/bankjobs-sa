import type { CanonicalJob, JobLocation } from '@bankjobs/core';
import {
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
import type { WorkdayJobPostingInfo, WorkdayRawPosting } from './workday/types';

const SOURCE = 'absa' as const;
const BRAND = 'Absa' as const;

/** Verified 2026-07-20. A new Workday bank later is a new config, not new code. */
export const ABSA_WORKDAY_CONFIG: WorkdayConfig = {
  host: 'absa.wd3.myworkdayjobs.com',
  tenant: 'absa',
  site: 'ABSAcareersite',
};

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

export const absaAdapter: SourceAdapter<WorkdayRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<WorkdayRawPosting[]> {
    return fetchAllWorkday(ABSA_WORKDAY_CONFIG, opts);
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

    // 'City, Province' only when both resolved; otherwise the raw string; null
    // when there is no location at all (e.g. non-SA sites still keep raw).
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
      brand: BRAND,
      title,
      category: categorize(title, SOURCE),
      employmentType: info.timeType ?? null,
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      // country is an OBJECT {descriptor, id}; map the descriptor to ISO alpha-2.
      // Some postings (group/pipeline roles) carry no location data at all — no
      // location, no country. Those default to ZA: this is Absa's SA careers
      // site, and 'International — ZZ' would be worse than an unlabelled SA row.
      // A descriptor that is present but unrecognized still maps to ZZ.
      country: info.country?.descriptor ? countryCodeFor(info.country.descriptor) : 'ZA',
      applyUrl: cleanApplyUrl(externalUrl),
      // startDate is the ISO posted date; NEVER the relative postedOn text.
      postedDate: info.startDate ?? null,
    };
  },
};
