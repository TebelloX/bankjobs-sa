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
import type { SuccessFactorsConfig } from './successfactors/client';
import { fetchAllSuccessFactorsSitemap } from './successfactors/client';
import type { SfSitemapPosting } from './successfactors/types';

const SOURCE = 'discovery' as const;
const BRAND = 'Discovery Bank' as const;

/** The exact 'Business Unit' value that tags a posting as a bank role. */
const BANK_BUSINESS_UNIT = 'Discovery Bank';

/**
 * Discovery's careers site is a GROUP-WIDE SAP SuccessFactors CSB site — every
 * Discovery Limited brand (Health, Insure, Vitality, Bank, …) posts there, and
 * the sitemap enumerates them all. Verified 2026-07-21. We crawl the whole site
 * (server-side filtering is ignored) via the sitemap path, then keep only the
 * bank. `sitemapPath` defaults to '/sitemap.xml' — the real URL sitemap here.
 */
export const DISCOVERY_SF_CONFIG: SuccessFactorsConfig = {
  host: 'careers.discovery.co.za',
};

export const discoveryAdapter: SourceAdapter<SfSitemapPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<SfSitemapPosting[]> {
    const all = await fetchAllSuccessFactorsSitemap(DISCOVERY_SF_CONFIG, opts);
    // Filter to the bank. FirstRand maps sub-brands; here we keep ONE brand and
    // drop the rest. Log the split — silent truncation is forbidden by house
    // rules. With only a handful of bank roles this can legitimately reach 0 one
    // day and trip the zero-jobs guardrail (warn + skip closures — by design).
    const kept = all.filter((p) => p.businessUnit.trim() === BANK_BUSINESS_UNIT);
    opts?.log?.(
      `${SOURCE}: ${all.length} group postings, ${kept.length} ${BRAND}, ` +
        `${all.length - kept.length} other-brand skipped`,
    );
    return kept;
  },

  normalize(raw: SfSitemapPosting): CanonicalJob {
    const jobId = raw.jobId?.trim();
    if (!jobId) {
      throw new AdapterNormalizeError(SOURCE, raw.title ?? raw.url ?? 'unknown', 'missing jobId');
    }

    const title = (raw.title ?? '').trim();
    const { html, text } = sanitizeDescription(raw.description ?? '');

    // country: this tenant's addressCountry microdata is an ISO alpha-2 code
    // ('ZA'), so a 2-letter value is uppercased directly; a display-name value
    // (defensive) maps via the core helper. Empty → 'ZZ', never a silent ZA.
    const rawCountry = (raw.country ?? '').trim();
    const country =
      rawCountry === ''
        ? 'ZZ'
        : /^[A-Za-z]{2}$/.test(rawCountry)
          ? rawCountry.toUpperCase()
          : countryCodeFor(rawCountry);

    // city via normalizeLocation over the addressLocality (standardbank pattern
    // exactly). The CSB locality combines suburb + building
    // ('Sandton - 1 Discovery Place'), but the substring scan still resolves the
    // city; a match yields city/province, everything else keeps the raw string.
    const rawLoc = (raw.locality ?? '').trim();
    const normalized = rawLoc === '' ? null : normalizeLocation(rawLoc);
    const locations: JobLocation[] =
      normalized === null
        ? []
        : [{ city: normalized.city, province: normalized.province, raw: normalized.raw }];

    const primaryLocation =
      normalized !== null && normalized.city !== null && normalized.province !== null
        ? `${normalized.city}, ${normalized.province}`
        : rawLoc === ''
          ? null
          : rawLoc;

    return {
      id: `${SOURCE}:${jobId}`,
      source: SOURCE,
      brand: BRAND,
      title,
      // The 'Function' labelled field folds into the categorize haystack.
      category: categorize(title, SOURCE, raw.jobFunction),
      // Nothing structured on the detail page provides employment type.
      employmentType: null,
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      country,
      // applyUrl = the stable public detail page. The real apply route is the
      // robots-disallowed, session-bound /talentcommunity/apply/{jobId}/, so the
      // durable link is the detail page itself (the Investec precedent).
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(raw.url)),
      postedDate: raw.postedDate,
    };
  },
};
