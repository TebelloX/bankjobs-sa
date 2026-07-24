import { describe, expect, it } from 'vitest';
import {
  formatPostedRelative,
  formatUpdatedAbsolute,
  formatUpdatedLabel,
  sastStatementDate,
} from '../src/lib/freshness';

// All instants below are UTC; SAST is fixed UTC+2 (no DST).
// 2026-07-23T17:58:00Z = 19:58 SAST on 23 Jul.

describe('formatUpdatedLabel', () => {
  it('same SAST day reads "today"', () => {
    expect(
      formatUpdatedLabel('2026-07-23T17:58:00Z', new Date('2026-07-23T20:30:00Z')),
    ).toBe('today 19:58');
  });

  it('an early-morning update stays "today" later that day', () => {
    // 22:30Z on the 23rd is already 00:30 SAST on the 24th.
    expect(
      formatUpdatedLabel('2026-07-23T22:30:00Z', new Date('2026-07-24T08:00:00Z')),
    ).toBe('today 00:30');
  });

  it('previous evening (>= 18:00 SAST) reads "last night"', () => {
    // The reported bug: 19:58 SAST ingest viewed at 07:25 SAST next morning.
    expect(
      formatUpdatedLabel('2026-07-23T17:58:00Z', new Date('2026-07-24T05:25:00Z')),
    ).toBe('last night 19:58');
  });

  it('previous afternoon (< 18:00 SAST) reads "yesterday"', () => {
    expect(
      formatUpdatedLabel('2026-07-23T13:00:00Z', new Date('2026-07-24T05:25:00Z')),
    ).toBe('yesterday 15:00');
  });

  it('the evening boundary is 18:00 SAST exactly', () => {
    const now = new Date('2026-07-24T09:00:00Z');
    expect(formatUpdatedLabel('2026-07-23T15:59:00Z', now)).toBe('yesterday 17:59');
    expect(formatUpdatedLabel('2026-07-23T16:00:00Z', now)).toBe('last night 18:00');
  });

  it('anything older falls back to the absolute form', () => {
    expect(
      formatUpdatedLabel('2026-07-20T10:00:00Z', new Date('2026-07-24T05:25:00Z')),
    ).toBe('20 Jul, 12:00');
  });

  it('handles unparseable input', () => {
    expect(formatUpdatedLabel('not-a-date', new Date('2026-07-24T05:25:00Z'))).toBe('unknown');
  });
});

describe('formatPostedRelative', () => {
  it('same SAST day reads "today"', () => {
    expect(formatPostedRelative('2026-07-23', new Date('2026-07-23T10:00:00Z'))).toBe('today');
  });

  it('rolls to "1d" at SAST midnight, not UTC midnight', () => {
    // 22:30Z on the 23rd is already 00:30 SAST on the 24th.
    expect(formatPostedRelative('2026-07-23', new Date('2026-07-23T22:30:00Z'))).toBe('1d');
  });

  it('counts whole days beyond yesterday', () => {
    expect(formatPostedRelative('2026-07-20', new Date('2026-07-24T05:00:00Z'))).toBe('4d');
  });

  it('is empty for null or malformed input', () => {
    expect(formatPostedRelative(null, new Date('2026-07-24T05:00:00Z'))).toBe('');
    expect(formatPostedRelative('garbage', new Date('2026-07-24T05:00:00Z'))).toBe('');
  });
});

describe('sastStatementDate', () => {
  it('formats the SAST calendar day at the given instant', () => {
    // 22:30Z on the 23rd is already the 24th in SAST.
    expect(sastStatementDate(new Date('2026-07-23T22:30:00Z'))).toBe('24 Jul 2026');
  });
});

describe('formatUpdatedAbsolute', () => {
  it('formats day, month and SAST time', () => {
    expect(formatUpdatedAbsolute('2026-07-23T17:58:00Z')).toBe('23 Jul, 19:58');
  });

  it('handles unparseable input', () => {
    expect(formatUpdatedAbsolute('not-a-date')).toBe('unknown');
  });
});
