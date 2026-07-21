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

export type {
  SrListResponse,
  SrListPosting,
  SrPostingDetail,
  SrLocation,
  SrEmploymentType,
  SrJobAd,
  SrJobAdSections,
  SrSection,
  SrRawPosting,
} from './smartrecruiters/types';

export type { SmartRecruitersConfig } from './smartrecruiters/client';
export {
  fetchPostingsList,
  fetchPostingDetail,
  fetchAllSmartRecruiters,
  SMARTRECRUITERS_UA,
} from './smartrecruiters/client';

export type {
  EarcuJobPosting,
  EarcuRawPosting,
  LdPlace,
  LdPostalAddress,
  LdPropertyValue,
} from './earcu/types';

export type { EarcuConfig } from './earcu/client';
export {
  fetchAllEarcu,
  extractPagestamp,
  extractDetailUrls,
  extractJobPostingLd,
  extractCanonicalUrl,
  cookieHeaderFrom,
  EARCU_UA,
} from './earcu/client';

export type {
  WorkableLocation,
  WorkableListItem,
  WorkableListResponse,
  WorkableJobDetail,
  WorkableRawPosting,
} from './workable/types';

export type { WorkableConfig } from './workable/client';
export {
  fetchWorkableJobList,
  fetchWorkableJobDetail,
  fetchAllWorkable,
  workableJobUrl,
  WORKABLE_UA,
} from './workable/client';

export type {
  OracleWorkLocation,
  OracleListRequisition,
  OracleListContainer,
  OracleListResponse,
  OracleRequisitionDetail,
  OracleDetailResponse,
  OracleRawPosting,
} from './oracle/types';

export type { OracleConfig } from './oracle/client';
export {
  fetchOracleJobList,
  fetchOracleJobDetail,
  fetchAllOracle,
  oracleJobUrl,
  ORACLE_UA,
} from './oracle/client';

export type { SfFeedItem, SfRawPosting, SfSitemapPosting } from './successfactors/types';

export type { SuccessFactorsConfig } from './successfactors/client';
export {
  parseFeed,
  extractDatePosted,
  extractCanonicalUrl as extractSfCanonicalUrl,
  extractJobId,
  fetchFeed,
  fetchAllSuccessFactors,
  parseSitemap,
  parseSitemapDetail,
  fetchSitemap,
  fetchAllSuccessFactorsSitemap,
  SUCCESSFACTORS_UA,
} from './successfactors/client';

import { absaAdapter } from './absa';
import { firstrandAdapter } from './firstrand';
import { standardbankAdapter } from './standardbank';
import { investecAdapter } from './investec';
import { gotymeAdapter } from './gotyme';
import { nedbankAdapter } from './nedbank';
import { discoveryAdapter } from './discovery';
import { capitecAdapter } from './capitec';
import { sarbAdapter } from './sarb';

export { absaAdapter, ABSA_WORKDAY_CONFIG } from './absa';
export { firstrandAdapter, FIRSTRAND_WORKDAY_CONFIG } from './firstrand';
export { standardbankAdapter, STANDARDBANK_SR_CONFIG } from './standardbank';
export { investecAdapter, INVESTEC_EARCU_CONFIG } from './investec';
export { gotymeAdapter, GOTYME_WORKABLE_CONFIG } from './gotyme';
export { nedbankAdapter, NEDBANK_SF_CONFIG } from './nedbank';
export { discoveryAdapter, DISCOVERY_SF_CONFIG } from './discovery';
export { capitecAdapter, CAPITEC_SF_CONFIG } from './capitec';
export { sarbAdapter, SARB_ORACLE_CONFIG } from './sarb';

/** Adapter registry — one entry per live source. */
export const adapters = {
  absa: absaAdapter,
  firstrand: firstrandAdapter,
  standardbank: standardbankAdapter,
  investec: investecAdapter,
  gotyme: gotymeAdapter,
  nedbank: nedbankAdapter,
  discovery: discoveryAdapter,
  capitec: capitecAdapter,
  sarb: sarbAdapter,
} as const;
