import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from '../src/fts';
import { resetRateLimiter } from '../src/ratelimit';
import { type ListResp, callJson } from './helpers';
import { seedAll } from './seed';

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('sanitizeFtsQuery', () => {
  it('quotes each token as a prefix term and ANDs them', () => {
    expect(sanitizeFtsQuery('hello')).toBe('"hello"*');
    expect(sanitizeFtsQuery('token AND')).toBe('"token"* "AND"*'); // AND is now a literal
    expect(sanitizeFtsQuery('a NEAR b')).toBe('"a"* "NEAR"* "b"*'); // NEAR neutralized
    expect(sanitizeFtsQuery('col:x')).toBe('"col"* "x"*'); // column filter neutralized
  });

  it('keeps unicode letters', () => {
    expect(sanitizeFtsQuery('café résumé')).toBe('"café"* "résumé"*');
  });

  it('returns empty for input that is all operators/punctuation', () => {
    expect(sanitizeFtsQuery('"')).toBe('');
    expect(sanitizeFtsQuery('*')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('* AND ""')).toBe('"AND"*'); // only the word survives
  });
});

describe('GET /api/jobs?q= hostile inputs never 500', () => {
  it('empty-after-sanitize falls back to an unfiltered listing', async () => {
    for (const q of ['"', '*', '   ']) {
      const { res, body } = await callJson<ListResp>(`/api/jobs?${new URLSearchParams({ q })}`);
      expect(res.status).toBe(200);
      expect(body.total).toBe(8); // same as no q
    }
  });

  it('operator-looking queries are treated as literal terms (200, no injection)', async () => {
    for (const q of ['token AND', 'a NEAR b', 'col:x', 'title:foo OR 1=1']) {
      const { res, body } = await callJson<ListResp>(`/api/jobs?${new URLSearchParams({ q })}`);
      expect(res.status).toBe(200);
      expect(body.total).toBe(0); // no seeded job matches these literals
    }
  });

  it('unicode query is handled without error', async () => {
    const { res, body } = await callJson<ListResp>(
      `/api/jobs?${new URLSearchParams({ q: 'café' })}`,
    );
    expect(res.status).toBe(200);
    expect(typeof body.total).toBe('number');
  });
});
