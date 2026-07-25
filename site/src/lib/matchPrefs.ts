// Remembered answers for /fit/ — the four things the visitor typed, kept in
// their own browser.
//
// No account, no server, no cookie: the whole feature is one localStorage key.
// NOTHING HERE IS EVER SENT ANYWHERE. That matters more on this page than
// anywhere else on the site, because these four strings are the closest thing
// to a CV the visitor will ever hand over — a qualification level, a field of
// study, a free-text degree name and a years-of-experience band. /about
// promises "We never take your CV or personal details", and this module is
// where that promise is either kept or quietly broken. It is kept by
// construction: the only sink in this file is storage.setItem.
//
// Kept dependency-free ON PURPOSE, exactly like savedJobs.ts and visit.ts: this
// runs inside the /fit/ island, so it must never import lib/data.ts. It knows
// nothing about Astro either — Storage is always a PARAMETER, never reached
// for, so node tests hand it a fake. Callers in the browser get the real thing
// from savedJobs.ts's getLocalStorage(), which is NOT re-implemented here:
// probing whether a write actually round-trips is subtle enough (Safari's
// private mode hands you a localStorage whose setItem always throws) that a
// second copy would be a second thing to get wrong.
//
// Reads are TOLERANT and writes NEVER throw, for the same reason as saved jobs:
// this value lives somewhere the visitor and their browser can mangle at any
// time. Every failure degrades to "nothing remembered" or "could not
// remember" — an empty form, never an exception that takes the island down and
// leaves the page dead.
//
// The stored strings are UI values (a select's value, an input's text), not a
// parsed profile. Prefill is best-effort and the page ignores slugs it does not
// recognise, so a taxonomy change or an edited-by-hand value costs a blank
// field, not a broken page — which is why this module validates shape and
// leaves meaning entirely to the caller.

/** localStorage key. Versioned: a v2 shape would be a new key, not a migration. */
export const MATCH_KEY = 'mybankjobs.match.v1';

/** The four form values, exactly as the controls hold them. All strings, '' = unset. */
export interface MatchPrefs {
  /** Qualification select value ('degree'). */
  qual: string;
  /** Field-of-study select value ('accounting'), '' for "any / not sure". */
  field: string;
  /** Free-text qualification name ('BCom Accounting'). */
  name: string;
  /** Years-of-experience select value ('3'), '' for "not saying". */
  years: string;
}

/** A string, or '' for anything that is not one (number, object, missing). */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The remembered answers, or null when there is nothing usable to prefill with.
 *
 * Tolerant by design — unusable storage, a read that throws, no stored value,
 * corrupt JSON and a value of the wrong SHAPE (an array, a string, a number,
 * null) all come back as null, which the page renders as an empty form.
 *
 * A stored OBJECT is always accepted, though, even when it is missing keys or
 * carries junk in them: those are coerced to '' rather than throwing the record
 * away. A half-written value from a killed tab, or a record written before a
 * field existed, should still restore the answers it does have — the caller
 * ignores values it cannot make sense of anyway, so the worst case is one blank
 * control instead of four.
 */
export function loadMatchPrefs(storage: Storage | null): MatchPrefs | null {
  if (!storage) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(MATCH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const v = parsed as Record<string, unknown>;
  return { qual: str(v.qual), field: str(v.field), name: str(v.name), years: str(v.years) };
}

/**
 * Remember the answers on this device. Returns whether they were actually
 * persisted — false, NEVER an exception, when storage is unusable or the write
 * is refused (a full quota, a private-mode window, storage disabled by policy).
 *
 * Only the four known fields are written, rebuilt explicitly rather than
 * stringifying whatever came in. The caller is a form-state object living in an
 * island that will grow more state than this over time, and "we only ever store
 * these four strings" has to stay true by inspection of this line, not by
 * everyone remembering not to pass extra keys.
 */
export function saveMatchPrefs(storage: Storage | null, prefs: MatchPrefs): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      MATCH_KEY,
      JSON.stringify({
        qual: str(prefs.qual),
        field: str(prefs.field),
        name: str(prefs.name),
        years: str(prefs.years),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
