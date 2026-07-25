import { describe, expect, it } from 'vitest';
import { MATCH_KEY, loadMatchPrefs, saveMatchPrefs } from '../src/lib/matchPrefs';
import type { MatchPrefs } from '../src/lib/matchPrefs';

/**
 * A Storage-shaped fake — the whole reason matchPrefs.ts takes `storage` as a
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
    return this.map.get(MATCH_KEY) ?? null;
  }
}

const PREFS: MatchPrefs = {
  qual: 'degree',
  field: 'accounting',
  name: 'BCom Accounting',
  years: '3',
};

const EMPTY: MatchPrefs = { qual: '', field: '', name: '', years: '' };

describe('saveMatchPrefs / loadMatchPrefs', () => {
  it('round-trips all four answers', () => {
    const s = new FakeStorage();
    expect(saveMatchPrefs(s, PREFS)).toBe(true);
    expect(loadMatchPrefs(s)).toEqual(PREFS);
  });

  it('round-trips the unanswered form', () => {
    const s = new FakeStorage();
    saveMatchPrefs(s, EMPTY);
    expect(loadMatchPrefs(s)).toEqual(EMPTY);
  });

  it('overwrites rather than accumulating', () => {
    const s = new FakeStorage();
    saveMatchPrefs(s, PREFS);
    saveMatchPrefs(s, { ...PREFS, name: 'BSc IT', field: 'it' });
    expect(loadMatchPrefs(s)).toEqual({ ...PREFS, name: 'BSc IT', field: 'it' });
  });

  it('uses the versioned key and stores ONLY the four known fields', () => {
    const s = new FakeStorage();
    // The caller is a form-state object that will grow; nothing else may leak
    // into storage on the one page where the visitor types about themselves.
    saveMatchPrefs(s, { ...PREFS, email: 'someone@example.com', cv: 'x' } as MatchPrefs);
    expect(JSON.parse(s.raw() ?? 'null')).toEqual(PREFS);
    expect(s.raw()).not.toContain('example.com');
  });

  it('reports false — and never throws — when the write is refused', () => {
    const s = new FakeStorage();
    s.failWrites = true;
    expect(saveMatchPrefs(s, PREFS)).toBe(false);
    expect(s.raw()).toBeNull();
    expect(loadMatchPrefs(s)).toBeNull();
  });

  it('leaves the previous answers untouched when a later write is refused', () => {
    const s = new FakeStorage();
    saveMatchPrefs(s, PREFS);
    const before = s.raw();
    s.failWrites = true;
    expect(saveMatchPrefs(s, { ...PREFS, name: 'lost' })).toBe(false);
    expect(s.raw()).toBe(before);
    expect(loadMatchPrefs(s)).toEqual(PREFS);
  });

  it('does nothing at all when there is no storage', () => {
    expect(saveMatchPrefs(null, PREFS)).toBe(false);
    expect(loadMatchPrefs(null)).toBeNull();
  });
});

describe('loadMatchPrefs tolerance', () => {
  it('is null when nothing was ever stored', () => {
    expect(loadMatchPrefs(new FakeStorage())).toBeNull();
  });

  it('is null on corrupt JSON', () => {
    const s = new FakeStorage();
    s.setItem(MATCH_KEY, '{"qual":"degree",');
    expect(loadMatchPrefs(s)).toBeNull();
  });

  it('is null when the stored value is not an object', () => {
    const s = new FakeStorage();
    for (const value of ['[]', '["degree"]', '"a string"', '42', 'null', 'true']) {
      s.setItem(MATCH_KEY, value);
      expect(loadMatchPrefs(s)).toBeNull();
    }
  });

  it('is null when reading storage throws', () => {
    const s = new FakeStorage();
    saveMatchPrefs(s, PREFS);
    s.failReads = true;
    expect(loadMatchPrefs(s)).toBeNull();
  });

  it('keeps the answers a partial record does have', () => {
    // A half-written value from a killed tab, or a record predating a field:
    // one blank control beats four.
    const s = new FakeStorage();
    s.setItem(MATCH_KEY, JSON.stringify({ qual: 'degree', name: 'BCom' }));
    expect(loadMatchPrefs(s)).toEqual({ qual: 'degree', field: '', name: 'BCom', years: '' });
  });

  it('coerces non-string values to empty rather than handing them to the form', () => {
    const s = new FakeStorage();
    s.setItem(
      MATCH_KEY,
      JSON.stringify({ qual: 7, field: { slug: 'it' }, name: null, years: ['3'] }),
    );
    expect(loadMatchPrefs(s)).toEqual(EMPTY);
  });

  it('passes unrecognised slugs through — meaning is the caller’s problem', () => {
    // Prefill is best-effort: the page ignores values it cannot map, so a
    // retired slug costs a blank control, not a null record.
    const s = new FakeStorage();
    s.setItem(MATCH_KEY, JSON.stringify({ ...PREFS, field: 'basket-weaving' }));
    expect(loadMatchPrefs(s)?.field).toBe('basket-weaving');
  });

  it('ignores unrelated keys stored alongside it', () => {
    const s = new FakeStorage();
    s.setItem('mybankjobs.saved.v1', '[]');
    saveMatchPrefs(s, PREFS);
    expect(loadMatchPrefs(s)).toEqual(PREFS);
  });
});
