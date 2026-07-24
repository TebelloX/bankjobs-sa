import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED,
  SAVED_KEY,
  getLocalStorage,
  isSaved,
  loadSaved,
  removeSaved,
  toggleSaved,
} from '../src/lib/savedJobs';
import type { SavedJobInput } from '../src/lib/savedJobs';

/**
 * A Storage-shaped fake — the whole reason savedJobs.ts takes `storage` as a
 * parameter instead of reaching for window. `failWrites` reproduces the two
 * real-world refusals the module has to survive: a full quota and Safari's
 * private mode, where setItem throws on every call.
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  failWrites = false;
  failReads = false;

  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException('SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  /** Raw stored JSON, for assertions about what actually landed. */
  raw(): string | null {
    return this.map.get(SAVED_KEY) ?? null;
  }
}

const JOB: SavedJobInput = {
  id: 'absa:R-15989289',
  slug: 'absa-r-15989289',
  title: 'Corporate Actions Team Leader',
  brand: 'Absa',
  category: 'Other',
  primaryLocation: 'Sandton, Gauteng',
  postedDate: '2026-07-21',
};

const OTHER: SavedJobInput = {
  id: 'capitec:1386772233',
  slug: 'capitec-1386772233',
  title: 'Lead Analyst: Profitability',
  brand: 'Capitec',
  category: 'Other',
  primaryLocation: 'Stellenbosch, Western Cape',
  postedDate: '2026-07-21',
};

/** A stored entry with an explicit savedAt, for order/eviction fixtures. */
function stored(input: SavedJobInput, savedAt: string) {
  return { ...input, savedAt };
}

function at(iso: string): Date {
  return new Date(iso);
}

describe('toggleSaved', () => {
  it('round-trips: save, then unsave', () => {
    const s = new FakeStorage();

    expect(toggleSaved(s, JOB, at('2026-07-24T10:00:00.000Z'))).toEqual({ saved: true, ok: true });
    expect(isSaved(s, JOB.id)).toBe(true);
    expect(loadSaved(s)).toEqual([{ ...JOB, savedAt: '2026-07-24T10:00:00.000Z' }]);

    expect(toggleSaved(s, JOB, at('2026-07-24T11:00:00.000Z'))).toEqual({ saved: false, ok: true });
    expect(isSaved(s, JOB.id)).toBe(false);
    expect(loadSaved(s)).toEqual([]);
  });

  it('stores everything a closed vacancy needs to still render', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB, at('2026-07-24T10:00:00.000Z'));
    const [entry] = loadSaved(s);
    expect(entry).toMatchObject({
      title: JOB.title,
      brand: JOB.brand,
      category: JOB.category,
      primaryLocation: JOB.primaryLocation,
      postedDate: JOB.postedDate,
      slug: JOB.slug,
    });
  });

  it('keeps null location / posted date as null', () => {
    const s = new FakeStorage();
    toggleSaved(s, { ...JOB, primaryLocation: null, postedDate: null });
    expect(loadSaved(s)[0]).toMatchObject({ primaryLocation: null, postedDate: null });
  });

  it('refuses a vacancy missing a required field, without touching storage', () => {
    const s = new FakeStorage();
    expect(toggleSaved(s, { ...JOB, id: '' })).toEqual({ saved: false, ok: false });
    expect(s.raw()).toBeNull();
  });

  it('reports ok:false and the UNCHANGED state when the write is refused', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB, at('2026-07-24T10:00:00.000Z'));
    const before = s.raw();

    // Quota full / private mode: the save cannot stick, so the caller must be
    // told the job is still NOT saved rather than being handed a false label.
    s.failWrites = true;
    expect(toggleSaved(s, OTHER, at('2026-07-24T12:00:00.000Z'))).toEqual({
      saved: false,
      ok: false,
    });
    expect(s.raw()).toBe(before);
    expect(isSaved(s, OTHER.id)).toBe(false);

    // The reverse case: unsaving an already-saved job that cannot be written.
    expect(toggleSaved(s, JOB, at('2026-07-24T12:00:01.000Z'))).toEqual({
      saved: true,
      ok: false,
    });
    expect(s.raw()).toBe(before);
    expect(isSaved(s, JOB.id)).toBe(true);
  });

  it('does nothing when there is no storage at all', () => {
    expect(toggleSaved(null, JOB)).toEqual({ saved: false, ok: false });
    expect(isSaved(null, JOB.id)).toBe(false);
    expect(loadSaved(null)).toEqual([]);
  });
});

describe('loadSaved order contract', () => {
  it('returns newest savedAt first, whatever order they were stored in', () => {
    const s = new FakeStorage();
    s.setItem(
      SAVED_KEY,
      JSON.stringify([
        stored(JOB, '2026-07-01T08:00:00.000Z'),
        stored(OTHER, '2026-07-20T08:00:00.000Z'),
      ]),
    );
    expect(loadSaved(s).map((e) => e.id)).toEqual([OTHER.id, JOB.id]);
  });

  it('puts a fresh save at the top', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB, at('2026-07-24T10:00:00.000Z'));
    toggleSaved(s, OTHER, at('2026-07-24T10:00:01.000Z'));
    expect(loadSaved(s).map((e) => e.id)).toEqual([OTHER.id, JOB.id]);
  });

  it('collapses duplicate ids to the first stored occurrence', () => {
    const s = new FakeStorage();
    s.setItem(
      SAVED_KEY,
      JSON.stringify([
        stored(JOB, '2026-07-20T08:00:00.000Z'),
        stored({ ...JOB, title: 'Impostor' }, '2026-07-21T08:00:00.000Z'),
      ]),
    );
    const entries = loadSaved(s);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe(JOB.title);
  });
});

describe('loadSaved tolerance', () => {
  it('is empty when nothing was ever stored', () => {
    expect(loadSaved(new FakeStorage())).toEqual([]);
  });

  it('is empty on corrupt JSON', () => {
    const s = new FakeStorage();
    s.setItem(SAVED_KEY, '[{"id":"absa:1",');
    expect(loadSaved(s)).toEqual([]);
  });

  it('is empty when the stored value is not an array', () => {
    const s = new FakeStorage();
    for (const value of ['{"id":"absa:1"}', '"a string"', '42', 'null']) {
      s.setItem(SAVED_KEY, value);
      expect(loadSaved(s)).toEqual([]);
    }
  });

  it('drops entries missing a required field and keeps the rest', () => {
    const s = new FakeStorage();
    s.setItem(
      SAVED_KEY,
      JSON.stringify([
        stored(JOB, '2026-07-20T08:00:00.000Z'),
        { ...stored(OTHER, '2026-07-21T08:00:00.000Z'), slug: undefined },
        { ...stored(OTHER, '2026-07-22T08:00:00.000Z'), title: '' },
        { ...stored(OTHER, '2026-07-23T08:00:00.000Z'), savedAt: undefined },
        { ...stored(OTHER, '2026-07-23T08:00:00.000Z'), id: 42 },
        'not an object',
        null,
      ]),
    );
    expect(loadSaved(s).map((e) => e.id)).toEqual([JOB.id]);
  });

  it('normalises unusable nullable fields to null rather than dropping the row', () => {
    const s = new FakeStorage();
    s.setItem(
      SAVED_KEY,
      JSON.stringify([
        { ...stored(JOB, '2026-07-20T08:00:00.000Z'), primaryLocation: 7, postedDate: {} },
      ]),
    );
    expect(loadSaved(s)[0]).toMatchObject({ primaryLocation: null, postedDate: null });
  });

  it('is empty when reading storage throws', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB);
    s.failReads = true;
    expect(loadSaved(s)).toEqual([]);
    expect(isSaved(s, JOB.id)).toBe(false);
  });
});

describe('removeSaved', () => {
  it('drops the entry and leaves the others', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB, at('2026-07-24T10:00:00.000Z'));
    toggleSaved(s, OTHER, at('2026-07-24T10:00:01.000Z'));

    expect(removeSaved(s, JOB.id)).toEqual({ removed: true, ok: true });
    expect(loadSaved(s).map((e) => e.id)).toEqual([OTHER.id]);
  });

  it('reports removed:false for an id that is not saved, and writes nothing', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB);
    const before = s.raw();
    expect(removeSaved(s, 'nedbank:nope')).toEqual({ removed: false, ok: true });
    expect(s.raw()).toBe(before);
  });

  it('reports ok:false and keeps the entry when the write is refused', () => {
    const s = new FakeStorage();
    toggleSaved(s, JOB);
    s.failWrites = true;
    expect(removeSaved(s, JOB.id)).toEqual({ removed: false, ok: false });
    expect(isSaved(s, JOB.id)).toBe(true);
  });

  it('is a no-op without storage or without an id', () => {
    expect(removeSaved(null, JOB.id)).toEqual({ removed: false, ok: false });
    expect(removeSaved(new FakeStorage(), '')).toEqual({ removed: false, ok: false });
  });
});

describe('MAX_SAVED eviction', () => {
  it('caps the list and evicts the OLDEST savedAt', () => {
    const s = new FakeStorage();
    // MAX_SAVED entries, oldest first — job-0 is the one that must go.
    const full = Array.from({ length: MAX_SAVED }, (_, i) =>
      stored(
        { ...JOB, id: `absa:job-${i}`, slug: `absa-job-${i}`, title: `Job ${i}` },
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      ),
    );
    s.setItem(SAVED_KEY, JSON.stringify(full));
    expect(loadSaved(s)).toHaveLength(MAX_SAVED);

    expect(toggleSaved(s, OTHER, at('2026-07-24T10:00:00.000Z'))).toEqual({
      saved: true,
      ok: true,
    });

    const ids = loadSaved(s).map((e) => e.id);
    expect(ids).toHaveLength(MAX_SAVED);
    expect(ids[0]).toBe(OTHER.id); // newest first
    expect(ids).not.toContain('absa:job-0'); // oldest evicted
    expect(ids).toContain(`absa:job-${MAX_SAVED - 1}`); // second-newest kept
  });
});

describe('getLocalStorage', () => {
  it('returns null where there is no window (node, SSR)', () => {
    expect(getLocalStorage()).toBeNull();
  });
});
