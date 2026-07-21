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

const SOURCE = 'capitec' as const;
const BRAND = 'Capitec' as const;

/**
 * Capitec's careers site is a SINGLE-BRAND SAP SuccessFactors CSB site — every
 * posting is Capitec, so there is no business-unit filter (the Discovery split
 * has no analogue here). Verified live 2026-07-21. It serves a REAL `<urlset>`
 * sitemap at '/sitemap.xml' (like Discovery, NOT the Google-for-Jobs RSS Nedbank
 * serves at that path), so the sitemap-driven path is the one to call.
 *
 * The detail pages differ from Discovery's: the title is schema.org ELEMENT
 * microdata (`<h1 itemprop="title">`) rather than a labelled CSB span, there are
 * no business-unit/function labelled spans, and the address is usually a single
 * `streetAddress` ("City, ZA" or a bare "ZA" for a nationwide/pipeline role).
 * The shared client parser tolerates all of that; this adapter stays thin.
 *
 * NEVER fetch www.capitecbank.co.za — the marketing site is Cloudflare-challenge
 * protected (403). Only the careers subdomain is used, and it is unprotected.
 */
export const CAPITEC_SF_CONFIG: SuccessFactorsConfig = {
  host: 'careers.capitecbank.co.za',
};

export const capitecAdapter: SourceAdapter<SfSitemapPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<SfSitemapPosting[]> {
    // Keep EVERY posting: a single-brand site has no business unit to filter on.
    // The shared client already logs the sitemap/parsed/skipped counts per run.
    return fetchAllSuccessFactorsSitemap(CAPITEC_SF_CONFIG, opts);
  },

  normalize(raw: SfSitemapPosting): CanonicalJob {
    const jobId = raw.jobId?.trim();
    if (!jobId) {
      throw new AdapterNormalizeError(SOURCE, raw.title ?? raw.url ?? 'unknown', 'missing jobId');
    }

    const title = (raw.title ?? '').trim();
    const { html, text } = sanitizeDescription(raw.description ?? '');

    // country: Capitec's addressCountry / streetAddress-suffix is an ISO alpha-2
    // code ('ZA'), so a 2-letter value is uppercased directly; a display-name
    // value (defensive) maps via the core helper. Empty → 'ZZ', never a silent
    // ZA (the discovery/standardbank convention).
    const rawCountry = (raw.country ?? '').trim();
    const country =
      rawCountry === ''
        ? 'ZZ'
        : /^[A-Za-z]{2}$/.test(rawCountry)
          ? rawCountry.toUpperCase()
          : countryCodeFor(rawCountry);

    // city via normalizeLocation over the locality (discovery/standardbank
    // pattern). A matched SA city resolves to city/province; a nationwide or
    // pipeline role carries no locality, so it stays locationless — a location
    // is never invented for it.
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
      // Capitec exposes no Function/department field, so categorize runs on the
      // title alone. Bankers (Business/Acquisition Banker) land in Sales via the
      // global 'banker' rule; graduate/internship programmes fall to 'Other'.
      // A per-source rule maps 'Bank Better Champion' — Capitec's known frontline
      // branch title, absent from the current inventory — to Branch & Retail,
      // so it categorizes correctly the moment such roles appear.
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
      // robots-disallowed, session-bound /talentcommunity/ flow, so the durable
      // link is the detail page itself (the Investec/Discovery precedent).
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(raw.url)),
      postedDate: raw.postedDate,
    };
  },
};
