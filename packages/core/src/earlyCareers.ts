import rulesData from './data/early-careers-rules.json';
import { keywordToRegex } from './keywords';

// Early-careers detection is a BUILD-TIME site concern only: it drives the
// /browse/graduate-programmes/ hub and nothing else. It is deliberately not a
// category, not a stored column, and not an API filter — roughly a dozen live
// jobs do not justify a schema change, a migration and the diff/hash blast
// radius that comes with one. If API-side filtering is ever wanted, the escape
// hatch is a column added then, not a keyword list duplicated in two places.
//
// Suffixed forms ('internship', 'learnership', 'apprenticeship') are listed
// separately because the word boundaries in keywordToRegex are strict: 'intern'
// does not match "Internship" any more than it matches "Internal". 'graduate
// programme' is subsumed by 'graduate' and matches nothing extra — it stays
// because the rules file doubles as the plain statement of what the hub
// collects.
const MATCHERS: RegExp[] = rulesData.keywords.map(keywordToRegex);

/**
 * True when a job title reads as an early-careers role — a graduate programme,
 * learnership, internship, bursary, traineeship or apprenticeship.
 *
 * Title only: the banks' own descriptions are long marketing prose that mention
 * "graduate" in the requirements of plenty of senior roles ("a relevant
 * graduate degree"), so matching them would flood the hub.
 */
export function isEarlyCareers(title: string): boolean {
  return MATCHERS.some((matcher) => matcher.test(title));
}
