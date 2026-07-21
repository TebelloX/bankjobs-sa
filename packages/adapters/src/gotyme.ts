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
import type { WorkableConfig } from './workable/client';
import { fetchAllWorkable, workableJobUrl } from './workable/client';
import type { WorkableJobDetail, WorkableRawPosting } from './workable/types';

const SOURCE = 'gotyme' as const;
const BRAND = 'GoTyme Bank' as const;

/**
 * GoTyme Bank (ex-TymeBank; tymebank.co.za 301s to gotyme.co.za) runs its SA
 * careers on Workable. The slug is NOT discoverable from gotyme.co.za's own HTML
 * or sitemap, so it is pinned here (verified live 2026-07-21). Distinct from
 * GoTyme Philippines (gotyme.com.ph) — never mix the two.
 */
export const GOTYME_WORKABLE_CONFIG: WorkableConfig = {
  slug: 'gotyme-za-south-africa',
};

/**
 * Workable employment tokens → the human-readable labels the other adapters emit
 * (Standard Bank's 'Full-time'/'Part-time' style). Unknown or absent tokens
 * yield null rather than an invented label.
 */
const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full: 'Full-time',
  part: 'Part-time',
  contract: 'Contract',
  temporary: 'Temporary',
  internship: 'Internship',
  trainee: 'Trainee',
  freelance: 'Freelance',
  apprenticeship: 'Apprenticeship',
};

function normalizeEmploymentType(raw: string | undefined): string | null {
  const token = raw?.trim().toLowerCase();
  if (!token) return null;
  return EMPLOYMENT_TYPE_LABELS[token] ?? null;
}

/**
 * Build the display HTML from the detail's HTML sections. All three carry real,
 * per-role signal (unlike Standard Bank's generic companyDescription), so each
 * non-empty block is kept in reading order.
 */
function buildDescriptionHtml(detail: WorkableJobDetail): string {
  return [detail.description, detail.requirements, detail.benefits]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join('');
}

export const gotymeAdapter: SourceAdapter<WorkableRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<WorkableRawPosting[]> {
    return fetchAllWorkable(GOTYME_WORKABLE_CONFIG, opts);
  },

  normalize(raw: WorkableRawPosting): CanonicalJob {
    const detail = raw.detail;

    const shortcode = detail.shortcode?.trim();
    if (!shortcode) {
      throw new AdapterNormalizeError(SOURCE, detail.title ?? 'unknown', 'missing shortcode');
    }

    // The stable public job page; slug comes from THIS adapter's config, so
    // stand-in fixtures normalize under the GoTyme apply origin by design.
    const applyUrl = workableJobUrl(GOTYME_WORKABLE_CONFIG.slug, shortcode);
    if (applyUrl.trim() === '') {
      throw new AdapterNormalizeError(SOURCE, `${SOURCE}:${shortcode}`, 'missing applyUrl');
    }

    const title = (detail.title ?? '').trim();
    const { html, text } = sanitizeDescription(buildDescriptionHtml(detail));

    // Prefer the ISO alpha-2 the API ships directly (the standardbank
    // convention); fall back to mapping the display name for records that omit
    // it. An empty or table-unknown value yields 'ZZ', never a silent ZA.
    const isoCode = (detail.location?.countryCode ?? '').trim();
    const country =
      isoCode !== ''
        ? isoCode.toUpperCase()
        : countryCodeFor((detail.location?.country ?? '').trim());

    // normalizeLocation over the city (standardbank pattern exactly): matched SA
    // cities resolve to city/province; everything else keeps the raw fallback.
    const rawCity = (detail.location?.city ?? '').trim();
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

    // published is a full ISO timestamp; the date part is the canonical posted
    // date. Unlike Investec's, these dates are real.
    const postedDate =
      detail.published && detail.published.length >= 10 ? detail.published.slice(0, 10) : null;

    return {
      id: `${SOURCE}:${shortcode}`,
      source: SOURCE,
      brand: BRAND,
      title,
      // department is a label array; fold it into the categorize haystack.
      category: categorize(title, SOURCE, (detail.department ?? []).join(' ')),
      employmentType: normalizeEmploymentType(detail.type),
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      country,
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(applyUrl)),
      postedDate,
    };
  },
};
