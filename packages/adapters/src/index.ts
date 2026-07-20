export type { FetchOptions, SourceAdapter } from './types';
export { AdapterNormalizeError } from './types';

export type {
  WorkdayListResponse,
  WorkdayListPosting,
  WorkdayJobDetail,
  WorkdayJobPostingInfo,
  WorkdayJobRequisitionLocation,
  WorkdayCountryRef,
  WorkdayHiringOrganization,
  WorkdayRawPosting,
} from './workday/types';

export type { WorkdayConfig } from './workday/client';
export {
  fetchJobList,
  fetchJobDetail,
  fetchAllWorkday,
  HONEST_UA,
  BROWSER_UA,
} from './workday/client';

import { absaAdapter } from './absa';
export { absaAdapter, ABSA_WORKDAY_CONFIG } from './absa';

/** Adapter registry — absa only for now. */
export const adapters = { absa: absaAdapter } as const;
