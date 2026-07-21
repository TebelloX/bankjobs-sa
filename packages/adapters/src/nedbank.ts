import type { CanonicalJob, JobLocation } from '@bankjobs/core';
import {
  categorize,
  cleanApplyUrl,
  makeExcerpt,
  normalizeLocation,
  sanitizeDescription,
} from '@bankjobs/core';

import type { FetchOptions, SourceAdapter } from './types';
import { AdapterNormalizeError } from './types';
import type { SuccessFactorsConfig } from './successfactors/client';
import { fetchAllSuccessFactors } from './successfactors/client';
import type { SfRawPosting } from './successfactors/types';

const SOURCE = 'nedbank' as const;
const BRAND = 'Nedbank' as const;

/** Nedbank's SA careers run on SAP SuccessFactors CSB. Verified 2026-07-21. */
export const NEDBANK_SF_CONFIG: SuccessFactorsConfig = {
  host: 'jobs.nedbank.co.za',
};

/**
 * Split a g:location 'City, CC' into its city and ISO alpha-2 country. The
 * country is the trailing ', CC' suffix uppercased; a value without a 2-letter
 * suffix yields 'ZZ' (never a silent ZA), matching the standardbank/gotyme
 * convention that an unknown country is 'ZZ', not the home country.
 */
function splitLocation(raw: string): { city: string; country: string } {
  const trimmed = raw.trim();
  const m = /^(.*?),\s*([A-Za-z]{2})$/.exec(trimmed);
  if (!m) return { city: trimmed, country: 'ZZ' };
  return { city: (m[1] ?? '').trim(), country: (m[2] ?? '').toUpperCase() };
}

export const nedbankAdapter: SourceAdapter<SfRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<SfRawPosting[]> {
    return fetchAllSuccessFactors(NEDBANK_SF_CONFIG, opts);
  },

  normalize(raw: SfRawPosting): CanonicalJob {
    const { item, postedDate } = raw;

    const id = item.id?.trim();
    if (!id) {
      throw new AdapterNormalizeError(SOURCE, item.title ?? item.link ?? 'unknown', 'missing g:id');
    }

    const link = item.link?.trim();
    if (!link) {
      throw new AdapterNormalizeError(SOURCE, `${SOURCE}:${id}`, 'missing link');
    }

    const title = (item.title ?? '').trim();

    // Boilerplate decision: the feed ships each posting as ONE interleaved HTML
    // blob (Job Purpose / responsibilities / qualifications, prefixed by a
    // per-job requisition/recruiter header). Unlike Standard Bank, whose
    // SmartRecruiters payload exposes cleanly-named sections we can drop
    // structurally, Nedbank offers no reliable section boundary: the leading
    // heading label varies wildly across postings ('Requisition Details and
    // Talent Acquisition Contact' in only 2/77, plus 'Job Classification',
    // 'Requisition and Specialist Recruiter Details', … ) and the stale in-body
    // 'Closing date' appears in only 11/77. Excising it would require brittle
    // HTML surgery the plan warns against, so we sanitize the whole blob as-is.
    // The stale closing date is never parsed into a stored field — closure is
    // lastSeen-driven per the source trust rules.
    const { html, text } = sanitizeDescription(item.description ?? '');

    // country from the ', CC' suffix; city via normalizeLocation on the city
    // part (standardbank pattern exactly): a matched SA city resolves to
    // city/province, everything else keeps the raw string for display.
    const { city, country } = splitLocation(item.location ?? '');
    const normalized = city === '' ? null : normalizeLocation(city);
    const locations: JobLocation[] =
      normalized === null
        ? []
        : [{ city: normalized.city, province: normalized.province, raw: normalized.raw }];

    const primaryLocation =
      normalized !== null && normalized.city !== null && normalized.province !== null
        ? `${normalized.city}, ${normalized.province}`
        : city === ''
          ? null
          : city;

    return {
      id: `${SOURCE}:${id}`,
      source: SOURCE,
      brand: BRAND,
      title,
      // g:job_function folds into the categorize haystack alongside the title.
      category: categorize(title, SOURCE, item.jobFunction),
      // Nothing structured in the feed provides employment type.
      employmentType: null,
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      country,
      applyUrl: cleanApplyUrl(link),
      postedDate,
    };
  },
};
