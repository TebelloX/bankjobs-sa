import { describe, expect, it } from 'vitest';

import type { SuccessFactorsConfig } from '../src/index';
import { fetchFeed, fetchSitemap } from '../src/index';

// ---------------------------------------------------------------------------
// Retry policy of the load-bearing feed/sitemap GET. All SF tenants CNAME to
// the same SAP edge, so a transient connect failure there must not fail three
// sources at once — thrown fetches and 429/5xx retry per retryDelaysMs, while
// any other non-OK status is permanent and fails fast. Delays are [0, 0] so
// the suite never sleeps; the production default ([5000, 15000]) is config.
// ---------------------------------------------------------------------------

/** An outcome per attempt: 'network' rejects undici-style, a number is an
 * HTTP status, a string is a 200 body. Extra attempts fail the test. */
type Outcome = 'network' | number | string;

function stubFetch(outcomes: Outcome[]): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl: typeof fetch = (input) => {
    calls.push(String(input));
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error('stubFetch: more attempts than outcomes');
    if (outcome === 'network') {
      const cause = Object.assign(new Error('Connect Timeout Error'), {
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT',
      });
      return Promise.reject(new TypeError('fetch failed', { cause }));
    }
    if (typeof outcome === 'number') {
      return Promise.resolve(new Response('', { status: outcome }));
    }
    return Promise.resolve(new Response(outcome, { status: 200 }));
  };
  return { impl, calls };
}

function cfg(overrides?: Partial<SuccessFactorsConfig>): SuccessFactorsConfig {
  return { host: 'careers.example.co.za', retryDelaysMs: [0, 0], ...overrides };
}

describe('successfactors load-bearing fetch retry', () => {
  it('recovers from a transient network failure and logs the cause', async () => {
    const { impl, calls } = stubFetch(['network', '<rss/>']);
    const logs: string[] = [];
    const xml = await fetchFeed(cfg(), { fetchImpl: impl, log: (m) => logs.push(m) });

    expect(xml).toBe('<rss/>');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('https://careers.example.co.za/sitemap.xml');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('feed attempt 1/3 failed');
    expect(logs[0]).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(logs[0]).toContain('retrying in 0ms');
  });

  it('retries a 5xx and a 429, then succeeds on the last attempt', async () => {
    const { impl, calls } = stubFetch([503, 429, '<rss/>']);
    const xml = await fetchFeed(cfg(), { fetchImpl: impl });

    expect(xml).toBe('<rss/>');
    expect(calls).toHaveLength(3);
  });

  it('fails fast on a permanent status without retrying', async () => {
    const { impl, calls } = stubFetch([404]);
    await expect(fetchFeed(cfg(), { fetchImpl: impl })).rejects.toThrow(
      'SuccessFactors feed request failed: HTTP 404 for https://careers.example.co.za/sitemap.xml',
    );
    expect(calls).toHaveLength(1);
  });

  it('throws the last network error once retries are exhausted', async () => {
    const { impl, calls } = stubFetch(['network', 'network', 'network']);
    await expect(fetchFeed(cfg(), { fetchImpl: impl })).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(3);
  });

  it('makes a single attempt when retryDelaysMs is empty', async () => {
    const { impl, calls } = stubFetch(['network']);
    await expect(fetchFeed(cfg({ retryDelaysMs: [] }), { fetchImpl: impl })).rejects.toThrow(
      'fetch failed',
    );
    expect(calls).toHaveLength(1);
  });

  it('applies the same policy to the sitemap path', async () => {
    const { impl, calls } = stubFetch([500, 'network', '<urlset/>']);
    const xml = await fetchSitemap(cfg(), { fetchImpl: impl });

    expect(xml).toBe('<urlset/>');
    expect(calls).toHaveLength(3);
  });
});
