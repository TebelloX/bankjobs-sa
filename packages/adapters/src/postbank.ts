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
import type { PostbankConfig } from './postbank/client';
import { fetchAllPostbank } from './postbank/client';
import type { PostbankRawPosting } from './postbank/types';

const SOURCE = 'postbank' as const;
const BRAND = 'Postbank' as const;

/**
 * The South African Postbank SOC Ltd runs NO applicant tracking system. Its
 * careers page is a hand-maintained, server-rendered HTML table — position,
 * location, closing date — where every position links a PDF advert, and the PDF
 * IS the job ad. Verified live 2026-07-25: honest UA, HTTP 200 on both the page
 * and every advert; robots.txt constrains only Googlebot, on unrelated paths.
 *
 * Two consequences shape this adapter, both handled in the client:
 *   1. CLOSED ADS ARE NEVER REMOVED. The table is a year's archive (64 rows on
 *      2026-07-25, 2 of them still open), so the closing-date filter is the
 *      adapter's load-bearing logic, not a nicety.
 *   2. The hrefs are Windows paths with raw spaces ('vacancies\Advert_Specialist
 *      Architect 2026.pdf'), some carrying en-dashes and ampersands.
 */
export const POSTBANK_SITE_CONFIG: PostbankConfig = {
  host: 'www.postbank.co.za',
};

/**
 * Location cells are free text in ALL CAPS, and several list more than one
 * place: 'JOHANNESBURG\BLOEMFONTEIN', 'WESTERN CAPE AND KWAZULU NATAL X2',
 * 'WESTERN CAPE, NORTHERN CAPE, KWAZULU NATAL, NORTH-WEST, MPUMALANGA AND
 * LIMPOPO'. Split on the separators the page actually uses and drop the 'X2'
 * headcount markers, so each place resolves on its own — Absa is the precedent
 * for a job carrying several locations. Without the split, core's longest-match
 * scan picks whichever province happens to be the longest alias in the cell,
 * which is arbitrary; with it, the ad's own first-listed place leads.
 */
function splitLocations(rawLocation: string): string[] {
  return rawLocation
    .split(/\s*(?:[\\/,&]|\band\b)\s*/i)
    .map((part) => part.replace(/\bx\s*\d+\b/gi, '').trim())
    .filter((part) => part !== '');
}

/**
 * 'HEAD OFFICE' / 'Postbank Head Office' → 'Pretoria'. The adverts behind those
 * rows say so themselves ('LOCATION : HEAD OFFICE: PRETORIA'), so this resolves
 * an internal label to the place it names — it does not invent one. Any other
 * value is passed through untouched for core's normalizer to judge.
 */
function resolveHeadOffice(part: string): string {
  return /^(?:postbank\s+)?head\s*office\b/i.test(part) ? 'Pretoria' : part;
}

export const postbankAdapter: SourceAdapter<PostbankRawPosting> = {
  source: SOURCE,

  async fetchAll(opts?: FetchOptions): Promise<PostbankRawPosting[]> {
    return fetchAllPostbank(POSTBANK_SITE_CONFIG, opts);
  },

  normalize(raw: PostbankRawPosting): CanonicalJob {
    const { vacancy } = raw;

    const slug = vacancy.slug?.trim();
    if (!slug) {
      throw new AdapterNormalizeError(SOURCE, vacancy.title ?? 'unknown', 'missing advert slug');
    }
    if (!vacancy.pdfUrl || vacancy.pdfUrl.trim() === '') {
      throw new AdapterNormalizeError(SOURCE, `${SOURCE}:${slug}`, 'missing advert URL');
    }

    // Titles are published in CAPS ('SAP GRC SPECIALIST'). Left exactly as the
    // bank writes them: title-casing would wreck the acronyms this inventory is
    // full of (SAP, GRC, ETL, IT, CoSec).
    const title = (vacancy.title ?? '').trim();

    const { html, text } = sanitizeDescription(raw.advertHtml ?? '');

    const parts = splitLocations(vacancy.rawLocation ?? '').map(resolveHeadOffice);
    const normalized = parts.map((part) => normalizeLocation(part));
    const locations: JobLocation[] = normalized.map((n) => ({
      city: n.city,
      province: n.province,
      raw: n.raw,
    }));

    // 'City, Province' when both resolved; a matched province-only cell (half of
    // this source's rows are bare provinces) shows its canonical province name
    // rather than the shouted raw string; anything unmatched keeps the raw text.
    const first = normalized[0];
    const primaryLocation =
      first === undefined
        ? null
        : first.city !== null && first.province !== null
          ? `${first.city}, ${first.province}`
          : first.province !== null
            ? first.province
            : first.raw;

    return {
      id: `${SOURCE}:${slug}`,
      source: SOURCE,
      brand: BRAND,
      title,
      // Title-only, like Capitec and Investec: the advert's BUSINESS UNIT would
      // fold every data role in the IT department into Software & IT (the global
      // rules test Software & IT first), which is worse than the title alone.
      // Per-source rules cover what the global ones miss on this inventory:
      // the frontline 'Customer Services Clerk'/'Team Lead Customer Services'
      // (Branch & Retail, the Capitec 'Bank Better Champion' precedent), and the
      // IT titles the global 'specialist' rule was swallowing into
      // Operations & Admin ('Specialist Architect', 'SAP GRC Specialist').
      category: categorize(title, SOURCE),
      // The advert states POSITION STATUS (PERMANENT / FIXED-TERM CONTRACT),
      // which is a contract type, not the Full-time/Part-time schedule this
      // field carries elsewhere. Nothing states a schedule, so it stays null
      // rather than being filled with a value that means something else.
      employmentType: null,
      descriptionHtml: html,
      descriptionText: text,
      excerpt: makeExcerpt(text),
      primaryLocation,
      locations,
      // Postbank hires only in South Africa; every advert's location is an SA
      // province, city or the Pretoria head office.
      country: 'ZA',
      // applyUrl = the advert PDF itself. There is no application form anywhere:
      // each advert names the mailbox to send a CV to, so the PDF is both the ad
      // and the official application channel.
      applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(vacancy.pdfUrl)),
      // The page publishes a closing date but never a posted date, and the ad
      // itself carries none. The site falls back to firstSeen for JSON-LD.
      postedDate: null,
    };
  },
};
