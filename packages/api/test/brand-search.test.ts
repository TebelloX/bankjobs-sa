import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectBrand } from '../src/brands';
import { resetRateLimiter } from '../src/ratelimit';
import { type ListResp, callJson, ids } from './helpers';
import { seedAll, seedBrandFixtures } from './seed';

beforeAll(async () => {
  await seedAll(env.DB);
  await seedBrandFixtures(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

// Pure detection: no DB. Locks the edge-case behavior the SQL relies on.
describe('detectBrand', () => {
  it('maps an alias with no remainder to the brand', () => {
    expect(detectBrand('standard bank')).toEqual({ brand: 'Standard Bank', remainder: '' });
    expect(detectBrand('standardbank')).toEqual({ brand: 'Standard Bank', remainder: '' });
  });

  it('is case/spacing/punctuation insensitive', () => {
    expect(detectBrand('STANDARD   BANK')).toEqual({ brand: 'Standard Bank', remainder: '' });
    expect(detectBrand('standard-bank')).toEqual({ brand: 'Standard Bank', remainder: '' });
  });

  it('keeps the leftover words as the FTS remainder (alias at start, middle, end)', () => {
    expect(detectBrand('standard bank teller')).toEqual({
      brand: 'Standard Bank',
      remainder: 'teller',
    });
    expect(detectBrand('teller standard bank')).toEqual({
      brand: 'Standard Bank',
      remainder: 'teller',
    });
    expect(detectBrand('remote standard bank teller')).toEqual({
      brand: 'Standard Bank',
      remainder: 'remote teller',
    });
  });

  it('prefers the LONGEST alias', () => {
    // "capitec bank" (2 tokens) wins over the bare "capitec" (1 token).
    expect(detectBrand('capitec bank')).toEqual({ brand: 'Capitec', remainder: '' });
    // "discovery bank" wins over "discovery".
    expect(detectBrand('discovery bank')).toEqual({ brand: 'Discovery Bank', remainder: '' });
  });

  it('extracts at most one brand; leftmost wins a length tie, the rest stay in q', () => {
    // Both single-token aliases; leftmost ("investec") wins, "absa" stays for FTS.
    expect(detectBrand('investec absa')).toEqual({ brand: 'Investec', remainder: 'absa' });
    // A longer later alias still beats an earlier shorter one.
    expect(detectBrand('absa standard bank')).toEqual({
      brand: 'Standard Bank',
      remainder: 'absa',
    });
  });

  it('does not treat the generic words we excluded as brands', () => {
    expect(detectBrand('bank')).toBeNull();
    expect(detectBrand('standard')).toBeNull();
    expect(detectBrand('first')).toBeNull();
    expect(detectBrand('reserve')).toBeNull();
  });

  it('returns null when no alias is present', () => {
    expect(detectBrand('engineer')).toBeNull();
    expect(detectBrand('')).toBeNull();
  });
});

describe('GET /api/jobs?q= — bank-name interpretation', () => {
  it('q="Standard Bank" returns only Standard Bank rows; the SARB decoy is absent', async () => {
    const { body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ q: 'Standard Bank' })}`,
    );
    expect(body.total).toBe(2); // brand set, not the FTS "standard AND bank" set
    expect(ids(body).sort()).toEqual(['standardbank:R-200', 'standardbank:R-201']);
    expect(body.jobs.every((j) => j.brand === 'Standard Bank')).toBe(true);
    expect(ids(body)).not.toContain('sarb:1737'); // decoy mentioning standard+bank
  });

  it('q="standard bank teller" narrows to Standard Bank rows matching teller only', async () => {
    const { body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ q: 'standard bank teller' })}`,
    );
    expect(ids(body)).toEqual(['standardbank:R-201']);
    expect(ids(body)).not.toContain('standardbank:R-200'); // Risk Manager, no "teller"
    expect(ids(body)).not.toContain('absa:R-1'); // an Absa Branch Teller — wrong brand
  });

  it('q="Discovery Bank" and q="discovery" both return only Discovery Bank rows', async () => {
    for (const q of ['Discovery Bank', 'discovery']) {
      const { body } = await callJson<ListResp>(`/api/jobs?${new URLSearchParams({ q })}`);
      expect(ids(body)).toEqual(['discovery:R-1']);
      expect(ids(body)).not.toContain('investec:R-51'); // "product discovery" decoy
    }
  });

  it('q="engineer" (no alias) keeps the unchanged cross-brand FTS behavior', async () => {
    const { body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ q: 'engineer' })}`,
    );
    expect(body.total).toBe(2);
    expect(ids(body)).toContain('absa:R-2'); // title hit
    expect(ids(body)).toContain('investec:R-50'); // body-only hit
    expect(new Set(body.jobs.map((j) => j.brand)).size).toBe(2); // genuinely cross-brand
  });

  it('case/spacing/joined/punctuation variants all behave like "Standard Bank"', async () => {
    const expected = ['standardbank:R-200', 'standardbank:R-201'];
    for (const q of ['STANDARD   BANK', 'standardbank', 'standard-bank']) {
      const { body } = await callJson<ListResp>(`/api/jobs?${new URLSearchParams({ q })}`);
      expect(ids(body).sort()).toEqual(expected);
    }
  });

  it('q="fnb" returns FNB rows only (not the RMB row sharing the firstrand source)', async () => {
    const { body } = await callJson<ListResp>(`/api/jobs?${new URLSearchParams({ q: 'fnb' })}`);
    expect(ids(body)).toEqual(['firstrand:R-100']);
    expect(body.jobs[0]!.brand).toBe('FNB');
  });
});

describe('GET /api/jobs?brand= — explicit param', () => {
  it('matches the canonical brand case-insensitively', async () => {
    const { body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ brand: 'aBsA' })}`,
    );
    expect(body.total).toBe(3);
    expect(ids(body).sort()).toEqual(['absa:R-1', 'absa:R-2', 'absa:R-3']);
  });

  it('an unknown brand yields an empty set (like source)', async () => {
    const { body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ brand: 'NoSuchBank' })}`,
    );
    expect(body.total).toBe(0);
    expect(body.jobs).toEqual([]);
  });

  it('composes with q', async () => {
    const { body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ brand: 'Absa', q: 'teller' })}`,
    );
    expect(ids(body)).toEqual(['absa:R-1']); // Absa's Branch Teller only
  });
});
