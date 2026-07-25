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
import type { OracleConfig } from './oracle/client';
import { fetchAllOracle, oracleJobUrl } from './oracle/client';
import type { OracleRawPosting } from './oracle/types';

const SOURCE = 'sarb' as const;
const BRAND = 'SARB' as const;

/**
 * The South African Reserve Bank runs its careers on Oracle Recruiting Cloud
 * (Fusion HCM Candidate Experience). Verified live 2026-07-21. `CX_1002` is the
 * internal site number the friendly public 'SARB' slug aliases — both return
 * byte-identical requisition sets, and the number is the API-stable key the REST
 * finder takes. NEVER fetch www.resbank.co.za (an F5-style WAF blocks non-browser
 * traffic); the ORC host is the only data path.
 */
export const SARB_ORACLE_CONFIG: OracleConfig = {
  host: 'fa-evra-saasfaprod1.fa.ocs.oraclecloud.com',
  siteNumber: 'CX_1002',
  uiSite: 'SARB',
};

/**
 * Oracle `JobSchedule` labels → the house employment-type style (Standard Bank's
 * 'Full-time'/'Part-time'). 'Full time' is the only value SARB emits today (null
 * on a couple of roles); an unknown or absent value yields null, never an
 * invented label.
 */
const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  'full time': 'Full-time',
  'part time': 'Part-time',
};

function normalizeEmploymentType(raw: string | undefined): string | null {
  const key = raw?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  return EMPLOYMENT_TYPE_LABELS[key] ?? null;
}

export const sarbAdapter: SourceAdapter<OracleRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<OracleRawPosting[]> {
    return fetchAllOracle(SARB_ORACLE_CONFIG, opts);
  },

  normalize(raw: OracleRawPosting): CanonicalJob {
    const detail = raw.detail;

    const id = detail.Id?.trim();
    if (!id) {
      throw new AdapterNormalizeError(SOURCE, detail.Title ?? 'unknown', 'missing Id');
    }

    // Every SARB title echoes the req number as a leading '(1736) ' prefix. Strip
    // it ONLY when the parenthesised number is exactly this requisition's Id —
    // never touch interior parens like '(3 Year Contract)' or '(F5 & CISCO FTD)',
    // which carry real contract/scope information.
    const rawTitle = (detail.Title ?? '').trim();
    const idPrefix = `(${id})`;
    const title = rawTitle.startsWith(idPrefix) ? rawTitle.slice(idPrefix.length).trim() : rawTitle;

    // SARB posts its qualifications/requirements block (degree, NQF level, years
    // of experience) in a separate Oracle field, ExternalQualificationsStr, never
    // inlined into ExternalDescriptionStr. Fold both into one blob before
    // sanitizing — otherwise the requirements text never reaches the DB, which
    // starves both the job page and the requirements-extraction snapshot of that
    // content. Expect a one-time content-hash update wave across the ~25 live
    // SARB rows the run after this ships — that's this fold taking effect, not a
    // regression.
    const { html, text } = sanitizeDescription(
      [detail.ExternalDescriptionStr, detail.ExternalQualificationsStr].filter(Boolean).join('\n'),
    );

    // Location. SARB operates a single physical site — the Pretoria Head Office —
    // so every workLocation[] carries that address, even for roles advertised
    // nationwide. The candidate-facing signal is the requisition PrimaryLocation:
    // 'City, Country' for a located role vs a bare country ('South Africa') for a
    // nationwide one. Honor that: a nationwide role is locationless (country ZA,
    // no invented city — the Capitec bare-ZA precedent); the rest resolve their
    // city from the structured workLocation, with normalizeLocation driving the
    // province from the city (Region3 is informative only, per house convention).
    const work = detail.workLocation?.[0];
    const rawCountry = (work?.Country ?? '').trim();
    const country =
      rawCountry === ''
        ? 'ZZ'
        : /^[A-Za-z]{2}$/.test(rawCountry)
          ? rawCountry.toUpperCase()
          : countryCodeFor(rawCountry);

    const primaryLocationLabel = (detail.PrimaryLocation ?? '').trim();
    // 'City, Country' carries a comma; a bare country label does not — the latter
    // marks a nationwide/locationless role.
    const nationwide = primaryLocationLabel !== '' && !primaryLocationLabel.includes(',');
    const rawCity = nationwide ? '' : (work?.TownOrCity ?? '').trim();
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

    // ExternalPostedStartDate is the real full ISO posted timestamp; its date part
    // is canonical (matches the list's date-only PostedDate). Nullable-tolerant.
    const posted = detail.ExternalPostedStartDate;
    const postedDate = posted && posted.length >= 10 ? posted.slice(0, 10) : null;

    return {
      id: `${SOURCE}:${id}`,
      source: SOURCE,
      brand: BRAND,
      title,
      // Category + JobFunction fold into the categorize haystack. Per-source rules
      // map SARB's 'Policy and Regulation' analysts → Risk & Compliance and its
      // 'Administration' PA → Operations & Admin; everything else falls out of the
      // global rules (IT → Software & IT, Administrator/Coordinator → Ops & Admin).
      category: categorize(title, SOURCE, `${detail.Category ?? ''} ${detail.JobFunction ?? ''}`),
      employmentType: normalizeEmploymentType(detail.JobSchedule),
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      country,
      // applyUrl = the stable public job page. The '/apply' suffix is the flow
      // itself; we always link the posting page (the established precedent).
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(oracleJobUrl(SARB_ORACLE_CONFIG, id))),
      postedDate,
    };
  },
};
