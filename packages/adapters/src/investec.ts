import type { CanonicalJob, JobLocation } from '@bankjobs/core';
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
import type { EarcuConfig } from './earcu/client';
import { fetchAllEarcu } from './earcu/client';
import type { EarcuJobPosting, EarcuRawPosting, LdPlace } from './earcu/types';

const SOURCE = 'investec' as const;
const BRAND = 'Investec' as const;

/**
 * Investec's SA careers site runs on eArcu. Verified 2026-07-21; discovery moved
 * from the search-results grid to the sitemap on 2026-07-28 (the results page is
 * behind an AWS WAF JS challenge — see {@link fetchAllEarcu}). The sitemap path
 * is the eArcu default, so it stays out of this config.
 */
export const INVESTEC_EARCU_CONFIG: EarcuConfig = {
  host: 'careers.investec.co.za',
};

/**
 * schema.org employmentType tokens → the human-readable labels the other
 * adapters emit (Standard Bank's 'Full-time'/'Part-time' style). Unknown or
 * absent values yield null rather than an invented label.
 */
const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACTOR: 'Contract',
  TEMPORARY: 'Temporary',
  INTERN: 'Internship',
  VOLUNTEER: 'Volunteer',
  PER_DIEM: 'Per diem',
};

function normalizeEmploymentType(raw: EarcuJobPosting['employmentType']): string | null {
  const token = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim().toUpperCase();
  if (!token) return null;
  return EMPLOYMENT_TYPE_LABELS[token] ?? null;
}

/**
 * The requisition number from `identifier`, which is normally a PropertyValue
 * object ({value: '13787'}) but may be a bare string. Returns null when absent.
 */
function extractReqNumber(identifier: EarcuJobPosting['identifier']): string | null {
  if (typeof identifier === 'string') {
    return identifier.trim() === '' ? null : identifier.trim();
  }
  const value = identifier?.value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  return null;
}

/** First jobLocation, tolerating both the array and single-object schema forms. */
function firstPlace(jobLocation: EarcuJobPosting['jobLocation']): LdPlace | undefined {
  return Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
}

export const investecAdapter: SourceAdapter<EarcuRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<EarcuRawPosting[]> {
    return fetchAllEarcu(INVESTEC_EARCU_CONFIG, opts);
  },

  normalize(raw: EarcuRawPosting): CanonicalJob {
    const posting = raw.jsonLd;

    const reqNumber = extractReqNumber(posting?.identifier);
    if (!reqNumber) {
      throw new AdapterNormalizeError(
        SOURCE,
        posting?.title ?? raw.url ?? 'unknown',
        'missing identifier',
      );
    }

    const applyUrl = raw.url;
    if (!applyUrl || applyUrl.trim() === '') {
      throw new AdapterNormalizeError(SOURCE, `${SOURCE}:${reqNumber}`, 'missing applyUrl');
    }

    const title = (posting.title ?? '').trim();
    const { html, text } = sanitizeDescription(posting.description ?? '');

    const address = firstPlace(posting.jobLocation)?.address;

    // Mirror standardbank.ts: normalizeLocation over the city only. Some Investec
    // postings carry no JSON-LD city at all (an empty jobLocation array, or a
    // Place with an empty PostalAddress — the city lives in the title/slug, not
    // the data), which falls through to no location rather than a raw string.
    const rawCity = (address?.addressLocality ?? '').trim();
    const normalized = rawCity === '' ? null : normalizeLocation(rawCity);
    const locations: JobLocation[] =
      normalized === null
        ? []
        : [{ city: normalized.city, province: normalized.province, raw: normalized.raw }];

    const primaryLocation =
      normalized !== null && normalized.city !== null && normalized.province !== null
        ? `${normalized.city}, ${normalized.province}`
        : rawCity === ''
          ? null
          : rawCity;

    // addressCountry is a DISPLAY name ('South Africa'); map via the core helper.
    // Same reasoning as Absa: this is Investec's SA careers site, so a posting
    // with no country in its address defaults to ZA rather than 'International —
    // ZZ'. A present-but-unrecognized country name still maps to ZZ.
    const countryName = (address?.addressCountry ?? '').trim();
    const country = countryName === '' ? 'ZA' : countryCodeFor(countryName);

    return {
      id: `${SOURCE}:${reqNumber}`,
      source: SOURCE,
      brand: BRAND,
      title,
      category: categorize(title, SOURCE),
      employmentType: normalizeEmploymentType(posting.employmentType),
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      country,
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(applyUrl)),
      // datePosted is templated to today's date on every page load (untrusted)
      // and validThrough is unreliable, so we trust neither. The pipeline's
      // firstSeen carries recency instead.
      postedDate: null,
    };
  },
};
