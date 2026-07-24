// Saved vacancies — a shortlist kept in the visitor's own browser.
//
// No accounts, no server, no cookie: the whole feature is one localStorage key.
// Nothing here is ever sent anywhere, which is the point — the site holds no
// personal data and this must not become the exception.
//
// Kept dependency-free ON PURPOSE, exactly like share.ts and freshness.ts: this
// module is imported by client-bundled island code, so it must never import
// lib/data.ts (which pulls the gitignored job snapshot into the browser
// payload). It knows nothing about Astro either — every function takes the
// Storage object as a PARAMETER, so node tests can hand it a fake.
//
// Everything a saved row needs to RENDER is stored with it (title, brand,
// category, location, posted date), not just an id: the ledger is rebuilt three
// times a day and a job that closes disappears from the snapshot entirely. A
// shortlist that went blank when a vacancy closed would be worse than useless —
// the saved page still shows the row, marked as no longer listed.
//
// Reads are TOLERANT and writes NEVER throw: this data lives in a place the
// visitor (and their browser) can mangle at any time — private mode, a full
// quota, storage disabled by policy, a half-written value from a killed tab.
// Every failure degrades to "no saved jobs" or "could not save", never an
// exception that takes the page's script down with it.

/** localStorage key. Versioned: a v2 shape would be a new key, not a migration. */
export const SAVED_KEY = 'mybankjobs.saved.v1';

/**
 * Hard cap on stored rows. Saving past the cap evicts the OLDEST savedAt, so an
 * enthusiastic saver silently rolls their shortlist rather than filling the
 * origin's storage quota (~5MB) with a list nobody could read anyway.
 */
export const MAX_SAVED = 100;

/** One saved vacancy: enough to render a ledger row after the job has closed. */
export interface SavedJob {
  /** Stable job id ('absa:R-15989289') — the identity the snapshot is matched on. */
  id: string;
  /** URL slug, so a still-open row can link to /jobs/<slug>/. */
  slug: string;
  title: string;
  brand: string;
  category: string;
  /** 'Sandton, Gauteng' — null when the source gave no usable location. */
  primaryLocation: string | null;
  /** ISO date ('2026-07-21') — null when the source published no date. */
  postedDate: string | null;
  /** ISO timestamp of the save. The sort key: the list reads newest-first. */
  savedAt: string;
}

/** A vacancy handed to toggleSaved — savedAt is stamped by this module. */
export type SavedJobInput = Omit<SavedJob, 'savedAt'>;

/** Outcome of a toggle: the state that is now PERSISTED, and whether it stuck. */
export interface ToggleResult {
  /**
   * Whether the job is saved after the call. On a write failure this is the
   * UNCHANGED prior state — the label must never claim a save that did not
   * happen.
   */
  saved: boolean;
  /** false when storage was unusable or the write threw (quota, private mode). */
  ok: boolean;
}

/** Outcome of a remove. `removed: false, ok: true` = the id was not there. */
export interface RemoveResult {
  removed: boolean;
  ok: boolean;
}

// A key we write and immediately delete, only to find out whether writing works
// at all. Safari's old private mode exposes a localStorage whose setItem throws
// on every call, so merely reaching the object proves nothing.
const PROBE_KEY = 'mybankjobs.probe';

/**
 * The browser's localStorage, or null when it cannot be used.
 *
 * ACCESSING window.localStorage is itself throwable (a SecurityError when
 * storage is blocked by policy or by third-party-cookie settings in a frame),
 * so the property read sits inside the try as well. A non-null return means a
 * round-trip write actually succeeded a moment ago — which is what the job
 * page's save button gates its own visibility on: no dead control where the
 * save could never persist.
 */
export function getLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    if (!storage) return null;
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return storage;
  } catch {
    return null;
  }
}

/** A non-empty string, or null. Anything else (number, object, '') is null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Coerce one stored item into a SavedJob, or null to DROP it.
 *
 * Required fields (id, slug, title, brand, category, savedAt) must be non-empty
 * strings — a row missing any of them cannot be rendered or linked, so it is not
 * kept. The two nullable fields mirror the site's own data and are normalised to
 * null rather than dropping the row: a saved job with no posted date is fine.
 */
function normalizeEntry(value: unknown): SavedJob | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = str(v.id);
  const slug = str(v.slug);
  const title = str(v.title);
  const brand = str(v.brand);
  const category = str(v.category);
  const savedAt = str(v.savedAt);
  if (!id || !slug || !title || !brand || !category || !savedAt) return null;
  return {
    id,
    slug,
    title,
    brand,
    category,
    primaryLocation: str(v.primaryLocation),
    postedDate: str(v.postedDate),
    savedAt,
  };
}

/** Same validation for a caller-supplied vacancy, before it is ever stored. */
function normalizeInput(value: unknown): SavedJobInput | null {
  const entry = normalizeEntry({ ...(value as object), savedAt: 'x' });
  if (!entry) return null;
  const { savedAt: _savedAt, ...rest } = entry;
  return rest;
}

/**
 * Newest savedAt first. ISO-8601 timestamps sort correctly as plain strings, and
 * Array#sort is stable, so entries saved in the same millisecond keep the order
 * they were given — which is why a fresh save is prepended before sorting.
 */
function sortNewestFirst(entries: SavedJob[]): SavedJob[] {
  return [...entries].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

/**
 * Every saved vacancy, NEWEST SAVE FIRST (the order contract the saved page
 * renders in). Order contract: sorted by savedAt descending; ties keep stored
 * order.
 *
 * Tolerant by design — unreadable storage, corrupt JSON, a non-array value and
 * unrenderable rows all degrade to "nothing saved" (or to the rows that did
 * survive) rather than throwing. Duplicate ids collapse to the first occurrence.
 */
export function loadSaved(storage: Storage | null): SavedJob[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(SAVED_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: SavedJob[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return sortNewestFirst(entries);
}

/** Whether `id` is in the shortlist. */
export function isSaved(storage: Storage | null, id: string): boolean {
  if (!id) return false;
  return loadSaved(storage).some((entry) => entry.id === id);
}

/**
 * Persist the list, capped at MAX_SAVED (oldest savedAt dropped). Returns false
 * — never throws — when the write is refused: a full quota, a private-mode
 * window, storage disabled mid-session. The stored value is untouched in that
 * case, so the caller's state is still whatever load returns.
 */
function writeSaved(storage: Storage, entries: SavedJob[]): boolean {
  try {
    storage.setItem(SAVED_KEY, JSON.stringify(entries.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Save the vacancy if it is not saved, remove it if it is.
 *
 * `now` is injectable so tests get deterministic savedAt values; callers in the
 * browser leave it out. Returns the PERSISTED state — on a failed write the
 * `saved` flag is the unchanged prior state, so the button label stays honest.
 */
export function toggleSaved(
  storage: Storage | null,
  entry: SavedJobInput,
  now: Date = new Date(),
): ToggleResult {
  if (!storage) return { saved: false, ok: false };
  const input = normalizeInput(entry);
  if (!input) return { saved: false, ok: false };

  const current = loadSaved(storage);
  const wasSaved = current.some((e) => e.id === input.id);
  const next = wasSaved
    ? current.filter((e) => e.id !== input.id)
    : sortNewestFirst([{ ...input, savedAt: now.toISOString() }, ...current]).slice(0, MAX_SAVED);

  const ok = writeSaved(storage, next);
  return { saved: ok ? !wasSaved : wasSaved, ok };
}

/**
 * Drop one vacancy from the shortlist. Removing an id that is not there is a
 * no-op that reports success — there is nothing to fail and nothing to write.
 */
export function removeSaved(storage: Storage | null, id: string): RemoveResult {
  if (!storage || !id) return { removed: false, ok: false };
  const current = loadSaved(storage);
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) return { removed: false, ok: true };
  const ok = writeSaved(storage, next);
  return { removed: ok, ok };
}
