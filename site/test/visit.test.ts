import { describe, expect, it } from 'vitest';
import {
  isNewSince,
  recordVisit,
  rotateVisit,
  sumAddedSince,
  SESSION_GAP_MS,
  VISIT_KEY,
} from '../src/lib/visit';

// All instants below are UTC; SAST is fixed UTC+2 (no DST).

/** A localStorage stand-in — the module never reaches for a real one. */
function fakeStorage(seed: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as Storage & { map: Map<string, string> };
}

describe('rotateVisit', () => {
  it('a first-ever visit has no previous visit to be new since', () => {
    expect(rotateVisit(null, '2026-07-25T10:00:00.000Z')).toEqual({
      prev: null,
      last: '2026-07-25T10:00:00.000Z',
    });
  });

  it('another page view inside the session gap does not rotate', () => {
    // Six ledger pages in ten minutes is one visit, not six.
    const stored = JSON.stringify({
      prev: '2026-07-20T08:00:00.000Z',
      last: '2026-07-25T10:00:00.000Z',
    });
    expect(rotateVisit(stored, '2026-07-25T10:10:00.000Z')).toEqual({
      prev: '2026-07-20T08:00:00.000Z',
      last: '2026-07-25T10:10:00.000Z',
    });
  });

  it('a gap longer than an hour ends the session and rotates', () => {
    const stored = JSON.stringify({
      prev: '2026-07-20T08:00:00.000Z',
      last: '2026-07-25T10:00:00.000Z',
    });
    expect(rotateVisit(stored, '2026-07-25T11:00:00.001Z')).toEqual({
      prev: '2026-07-25T10:00:00.000Z',
      last: '2026-07-25T11:00:00.001Z',
    });
  });

  it('the boundary is strictly greater than the gap', () => {
    const last = '2026-07-25T10:00:00.000Z';
    const stored = JSON.stringify({ prev: null, last });
    const exactly = new Date(Date.parse(last) + SESSION_GAP_MS).toISOString();
    expect(rotateVisit(stored, exactly).prev).toBeNull();
  });

  it('a clock that jumped backwards keeps the previous visit', () => {
    // A negative gap is device clock skew, not a new session — rotating here
    // would throw away a real "last visit".
    const stored = JSON.stringify({
      prev: '2026-07-20T08:00:00.000Z',
      last: '2026-07-25T10:00:00.000Z',
    });
    expect(rotateVisit(stored, '2026-07-25T09:00:00.000Z')).toEqual({
      prev: '2026-07-20T08:00:00.000Z',
      last: '2026-07-25T09:00:00.000Z',
    });
  });

  it('corrupt or unusable stored values start over as a first visit', () => {
    const now = '2026-07-25T10:00:00.000Z';
    const first = { prev: null, last: now };
    expect(rotateVisit('{not json', now)).toEqual(first);
    expect(rotateVisit('[]', now)).toEqual(first);
    expect(rotateVisit('"a string"', now)).toEqual(first);
    // No `last` — there is no session clock to continue.
    expect(rotateVisit(JSON.stringify({ prev: '2026-07-20T08:00:00.000Z' }), now)).toEqual(first);
    expect(rotateVisit(JSON.stringify({ last: 'not-a-date' }), now)).toEqual(first);
    expect(rotateVisit(JSON.stringify({ last: 12345 }), now)).toEqual(first);
  });

  it('drops an unusable prev but keeps a usable last', () => {
    const stored = JSON.stringify({ prev: 'garbage', last: '2026-07-25T10:00:00.000Z' });
    expect(rotateVisit(stored, '2026-07-25T10:10:00.000Z')).toEqual({
      prev: null,
      last: '2026-07-25T10:10:00.000Z',
    });
  });
});

describe('recordVisit', () => {
  it('writes the rotated record under the versioned key', () => {
    const storage = fakeStorage({
      [VISIT_KEY]: JSON.stringify({ prev: null, last: '2026-07-24T10:00:00.000Z' }),
    });
    const record = recordVisit(storage, '2026-07-25T10:00:00.000Z');
    expect(record).toEqual({ prev: '2026-07-24T10:00:00.000Z', last: '2026-07-25T10:00:00.000Z' });
    expect(JSON.parse(storage.getItem(VISIT_KEY)!)).toEqual(record);
  });

  it('is idempotent within the session gap', () => {
    // Base.astro and the homepage script both call it on the same page view.
    const storage = fakeStorage({
      [VISIT_KEY]: JSON.stringify({ prev: null, last: '2026-07-24T10:00:00.000Z' }),
    });
    const first = recordVisit(storage, '2026-07-25T10:00:00.000Z');
    const second = recordVisit(storage, '2026-07-25T10:00:00.030Z');
    expect(second.prev).toBe(first.prev);
    expect(second.last).toBe('2026-07-25T10:00:00.030Z');
  });

  it('unusable storage degrades to a first visit, not an exception', () => {
    expect(recordVisit(null, '2026-07-25T10:00:00.000Z')).toEqual({
      prev: null,
      last: '2026-07-25T10:00:00.000Z',
    });
  });

  it('a refused write still returns this page view’s record', () => {
    const storage = fakeStorage({
      [VISIT_KEY]: JSON.stringify({ prev: null, last: '2026-07-24T10:00:00.000Z' }),
    });
    storage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    expect(recordVisit(storage, '2026-07-25T10:00:00.000Z')).toEqual({
      prev: '2026-07-24T10:00:00.000Z',
      last: '2026-07-25T10:00:00.000Z',
    });
  });

  it('a throwing read is treated as nothing stored', () => {
    const storage = fakeStorage();
    storage.getItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    expect(recordVisit(storage, '2026-07-25T10:00:00.000Z')).toEqual({
      prev: null,
      last: '2026-07-25T10:00:00.000Z',
    });
  });
});

describe('isNewSince', () => {
  it('is true only for rows first seen after the previous visit', () => {
    const prev = '2026-07-24T12:00:00.000Z';
    expect(isNewSince('2026-07-24T12:00:00.001Z', prev)).toBe(true);
    expect(isNewSince('2026-07-25T06:00:00.000Z', prev)).toBe(true);
    expect(isNewSince('2026-07-24T12:00:00.000Z', prev)).toBe(false);
    expect(isNewSince('2026-07-21T08:22:24.487Z', prev)).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(isNewSince(null, '2026-07-24T12:00:00.000Z')).toBe(false);
    expect(isNewSince('2026-07-25T06:00:00.000Z', null)).toBe(false);
    expect(isNewSince(null, null)).toBe(false);
    expect(isNewSince('', '2026-07-24T12:00:00.000Z')).toBe(false);
  });
});

describe('sumAddedSince', () => {
  const days = { '2026-07-21': 158, '2026-07-22': 4, '2026-07-23': 9, '2026-07-24': 12 };

  it('counts the days strictly after the visit day, in SAST', () => {
    // 10:00Z on the 22nd is 12:00 SAST — the 22nd's own count is skipped.
    expect(sumAddedSince(days, '2026-07-22T10:00:00.000Z')).toBe(21);
  });

  it('reckons the visit day in SAST, not UTC', () => {
    // 21:30Z on the 22nd is 23:30 SAST on the SAME day, so the 23rd and 24th
    // are what is new. Read as a UTC day this would agree; the next case is
    // where it does not.
    expect(sumAddedSince(days, '2026-07-22T21:30:00.000Z')).toBe(21);
    // 22:30Z on the 22nd is already 00:30 SAST on the 23rd, so the 23rd is the
    // visit day and only the 24th is new. A UTC reading would over-count by 9.
    expect(sumAddedSince(days, '2026-07-22T22:30:00.000Z')).toBe(12);
  });

  it('is 0 when the last visit is on or after the last counted day', () => {
    expect(sumAddedSince(days, '2026-07-24T09:00:00.000Z')).toBe(0);
    expect(sumAddedSince(days, '2026-07-30T09:00:00.000Z')).toBe(0);
  });

  it('is 0 for a first-ever visit, an unparseable stamp and an empty map', () => {
    expect(sumAddedSince(days, null)).toBe(0);
    expect(sumAddedSince(days, 'not-a-date')).toBe(0);
    expect(sumAddedSince({}, '2026-07-22T10:00:00.000Z')).toBe(0);
  });

  it('ignores counts that are not usable numbers', () => {
    const mangled = { '2026-07-23': Number.NaN, '2026-07-24': 12 } as Record<string, number>;
    expect(sumAddedSince(mangled, '2026-07-22T10:00:00.000Z')).toBe(12);
  });
});
