import rulesData from './data/entry-level-rules.json';
import { keywordToRegex } from './keywords';

// Entry-level detection is a BUILD-TIME site concern only: it drives the
// /browse/entry-level/ hub and nothing else. Like early careers it is
// deliberately not a category, not a stored column and not an API filter — a
// dozen live jobs do not justify a schema change, a migration and the diff/hash
// blast radius that comes with one. If API-side filtering is ever wanted, the
// escape hatch is a column added then, not a keyword list duplicated in two
// places.
//
// 'consultant sales' and 'consultant: sales' are listed beside 'sales
// consultant' because Absa posts both inversions ("Junior Consultant Sales
// (FAIS)", "Consultant: Sales (FAIS)") and the phrase keywords match in order,
// not as a bag of words — and keywordToRegex joins interior whitespace with
// \s+, which does not span the colon, so the punctuated variant needs its own
// keyword. Teaching the shared compiler to tolerate punctuation instead would
// loosen every other rule-driven classifier using it. 'bank better champion'
// is Capitec's frontline title vocabulary, pre-seeded so their branch channel
// needs no rules change when it posts.
const MATCHERS: RegExp[] = rulesData.keywords.map(keywordToRegex);

/**
 * True when a job title reads as an entry-level, frontline role — a teller,
 * cashier, service or sales consultant, or anything labelled junior.
 *
 * Title only, for the same reason as isEarlyCareers: the banks' descriptions
 * are long marketing prose that names the branch frontline in the requirements
 * of plenty of senior roles ("support our service consultants"), so matching
 * them would flood the hub.
 *
 * Independent of isEarlyCareers by design. The hub PAGE composes
 * `isEntryLevel && !isEarlyCareers`, because a learnership that happens to say
 * "Sales Consultant" belongs to /browse/graduate-programmes/ — but the two
 * predicates answer separate questions and neither subtracts the other.
 */
export function isEntryLevel(title: string): boolean {
  return MATCHERS.some((matcher) => matcher.test(title));
}
