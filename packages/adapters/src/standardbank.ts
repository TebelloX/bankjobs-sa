import type { CanonicalJob, JobLocation } from '@bankjobs/core';
import {
  assertAllowedApplyHost,
  categorize,
  cleanApplyUrl,
  makeExcerpt,
  normalizeLocation,
  sanitizeDescription,
} from '@bankjobs/core';

import type { FetchOptions, SourceAdapter } from './types';
import { AdapterNormalizeError } from './types';
import type { SmartRecruitersConfig } from './smartrecruiters/client';
import { fetchAllSmartRecruiters } from './smartrecruiters/client';
import type { SrJobAdSections, SrRawPosting } from './smartrecruiters/types';

const SOURCE = 'standardbank' as const;
const BRAND = 'Standard Bank' as const;

/** Standard Bank Group's SmartRecruiters company. Verified 2026-07-20. */
export const STANDARDBANK_SR_CONFIG: SmartRecruitersConfig = {
  company: 'standardbankgroup',
};

/**
 * Build the display HTML from the job ad's meaningful sections only. Each kept
 * section becomes `<h3>{title}</h3>{text}`. companyDescription (generic bank
 * boilerplate) and additionalInformation (legal/competency boilerplate) are
 * deliberately skipped — only jobDescription + qualifications carry real signal.
 */
function buildDescriptionHtml(sections: SrJobAdSections | undefined): string {
  const parts: string[] = [];
  for (const section of [sections?.jobDescription, sections?.qualifications]) {
    if (!section) continue;
    const text = (section.text ?? '').trim();
    if (text === '') continue;
    const title = (section.title ?? '').trim();
    if (title !== '') parts.push(`<h3>${title}</h3>`);
    parts.push(text);
  }
  return parts.join('');
}

export const standardbankAdapter: SourceAdapter<SrRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<SrRawPosting[]> {
    return fetchAllSmartRecruiters(STANDARDBANK_SR_CONFIG, opts);
  },

  normalize(raw: SrRawPosting): CanonicalJob {
    const detail = raw.detail;
    const id = detail?.id;
    if (!id || String(id).trim() === '') {
      throw new AdapterNormalizeError(SOURCE, detail?.name ?? 'unknown', 'missing id');
    }

    const applyUrl = detail.applyUrl;
    if (!applyUrl || applyUrl.trim() === '') {
      throw new AdapterNormalizeError(SOURCE, `${SOURCE}:${id}`, 'missing applyUrl');
    }

    const title = (detail.name ?? '').trim();
    const html = sanitizeDescription(buildDescriptionHtml(detail.jobAd?.sections));
    const description = html.text;

    // Uppercase the lowercase ISO alpha-2 country code directly. Unlike Workday
    // there is no missing-country case in practice, so we do NOT default to ZA;
    // an absent/empty code maps to 'ZZ'.
    const rawCountry = (detail.location?.country ?? '').trim();
    const country = rawCountry === '' ? 'ZZ' : rawCountry.toUpperCase();

    // normalizeLocation over the city (or full location string) — matched SA
    // cities resolve to city/province; everything else keeps the raw fallback.
    const rawLoc = detail.location?.city ?? detail.location?.fullLocation ?? '';
    const normalized = rawLoc.trim() === '' ? null : normalizeLocation(rawLoc);
    const locations: JobLocation[] =
      normalized === null
        ? []
        : [{ city: normalized.city, province: normalized.province, raw: normalized.raw }];

    // 'City, Province' when the SA lookup matched; otherwise the source city
    // string; null when there is no city at all.
    const primaryLocation =
      normalized !== null && normalized.city !== null && normalized.province !== null
        ? `${normalized.city}, ${normalized.province}`
        : (detail.location?.city ?? null);

    // postedDate = date part of the full ISO releasedDate timestamp.
    const postedDate =
      detail.releasedDate && detail.releasedDate.length >= 10
        ? detail.releasedDate.slice(0, 10)
        : null;

    return {
      id: `${SOURCE}:${id}`,
      source: SOURCE,
      brand: BRAND,
      title,
      category: categorize(title, SOURCE),
      employmentType: detail.typeOfEmployment?.label ?? null,
      descriptionHtml: html.html,
      descriptionText: description,
      excerpt: makeExcerpt(description),
      primaryLocation,
      locations,
      country,
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(applyUrl)),
      postedDate,
    };
  },
};
