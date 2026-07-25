export const SOURCES = [
  'absa',
  'firstrand',
  'standardbank',
  'investec',
  'gotyme',
  'nedbank',
  'discovery',
  'capitec',
  'sarb',
  'postbank',
] as const;
export type SourceId = (typeof SOURCES)[number];

// Canonical brand values exactly as stored on jobs.brand. A runtime list (not
// just a union) so the site can enumerate brands for the /banks/ landing pages
// — same idiom as SOURCES/CATEGORIES above. Order is the coverage order, not
// alphabetical: FirstRand's franchises sit together under the source that
// carries them.
export const BRANDS = [
  'Absa',
  'FNB',
  'RMB',
  'WesBank',
  'Ashburton',
  'DirectAxis',
  'FirstRand',
  'Standard Bank',
  'Investec',
  'GoTyme Bank',
  'Nedbank',
  'Discovery Bank',
  'Capitec',
  'SARB',
  'Postbank',
] as const;
export type Brand = (typeof BRANDS)[number];

export const CATEGORIES = [
  'Branch & Retail',
  'Sales',
  'Customer Service',
  'Software & IT',
  'Data & Analytics',
  'Finance & Accounting',
  'Risk & Compliance',
  'Credit & Lending',
  'Operations & Admin',
  'Other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_SLUGS: Record<Category, string> = {
  'Branch & Retail': 'branch-retail',
  Sales: 'sales',
  'Customer Service': 'customer-service',
  'Software & IT': 'software-it',
  'Data & Analytics': 'data-analytics',
  'Finance & Accounting': 'finance-accounting',
  'Risk & Compliance': 'risk-compliance',
  'Credit & Lending': 'credit-lending',
  'Operations & Admin': 'operations-admin',
  Other: 'other',
};

export const PROVINCES = [
  'Gauteng',
  'Western Cape',
  'KwaZulu-Natal',
  'Eastern Cape',
  'Free State',
  'Limpopo',
  'Mpumalanga',
  'North West',
  'Northern Cape',
] as const;
export type Province = (typeof PROVINCES)[number];

export interface JobLocation {
  city: string | null;
  province: Province | null;
  raw: string;
}

export interface CanonicalJob {
  id: string;
  source: SourceId;
  brand: Brand;
  title: string;
  category: Category;
  employmentType: string | null;
  descriptionHtml: string;
  descriptionText: string;
  excerpt: string;
  primaryLocation: string | null;
  locations: JobLocation[];
  /** ISO 3166-1 alpha-2, 'ZZ' if unknown. */
  country: string;
  applyUrl: string;
  postedDate: string | null;
}

export type JobStatus = 'open' | 'closed' | 'hidden';

export interface Job extends CanonicalJob {
  status: JobStatus;
  firstSeen: string;
  lastSeen: string;
  missedRuns: number;
  closedAt: string | null;
  updatedAt: string;
}

/**
 * Turn a job id like 'absa:R-15989226' into a URL slug 'absa-r-15989226'.
 * Lowercases, collapses runs of non-alphanumerics to a single '-', and trims
 * leading/trailing '-'.
 */
export function jobSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
