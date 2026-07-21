import { describe, expect, it } from 'vitest';
import { SOURCES, cleanApplyUrl } from '../src/index';
import type { SourceId } from '../src/index';
import {
  APPLY_HOST_ALLOWLIST,
  assertAllowedApplyHost,
  hostMatchesAllowlist,
} from '../src/applyUrl';

const cases: Array<[string, string, string]> = [
  [
    'strips utm_* params',
    'https://x.com/a?utm_source=g&utm_medium=m&keep=1',
    'https://x.com/a?keep=1',
  ],
  [
    'strips fbclid/gclid/source/src case-insensitively',
    'https://x.com/?fbclid=1&gclid=2&source=3&src=4&SRC=5&Source=6&real=7',
    'https://x.com/?real=7',
  ],
  [
    'leaves a clean url with a path unchanged',
    'https://absa.wd3.myworkdayjobs.com/ABSAcareersite/job/Lydenburg/Adviser_R-15987866',
    'https://absa.wd3.myworkdayjobs.com/ABSAcareersite/job/Lydenburg/Adviser_R-15987866',
  ],
  [
    'keeps non-tracking params',
    'https://x.com/search?q=analyst&page=2',
    'https://x.com/search?q=analyst&page=2',
  ],
];

describe('cleanApplyUrl', () => {
  it.each(cases)('%s', (_desc, input, expected) => {
    expect(cleanApplyUrl(input)).toBe(expected);
  });

  it('returns the raw input unchanged on parse failure', () => {
    expect(cleanApplyUrl('not a url')).toBe('not a url');
    expect(cleanApplyUrl('')).toBe('');
    expect(cleanApplyUrl('/relative/path')).toBe('/relative/path');
  });

  it('removes all tracking params but preserves the rest of the url', () => {
    const result = cleanApplyUrl('https://x.com/p?utm_campaign=a&fbclid=b');
    expect(result).toBe('https://x.com/p');
  });
});

// ---------------------------------------------------------------------------
// hostMatchesAllowlist — the exact/wildcard matcher underneath the guard.
// ---------------------------------------------------------------------------

describe('hostMatchesAllowlist', () => {
  it('matches an exact host and nothing that merely looks like it', () => {
    expect(hostMatchesAllowlist('jobs.smartrecruiters.com', ['jobs.smartrecruiters.com'])).toBe(
      true,
    );
    // A suffix-appended lookalike is a different host.
    expect(
      hostMatchesAllowlist('jobs.smartrecruiters.com.evil.com', ['jobs.smartrecruiters.com']),
    ).toBe(false);
    // A prefix-appended lookalike is a different host.
    expect(
      hostMatchesAllowlist('evil-jobs.smartrecruiters.com', ['jobs.smartrecruiters.com']),
    ).toBe(false);
  });

  it('matches a suffix wildcard only on a dot boundary with a label in front', () => {
    expect(hostMatchesAllowlist('absa.wd3.myworkdayjobs.com', ['*.myworkdayjobs.com'])).toBe(true);
    expect(hostMatchesAllowlist('firstrand.wd3.myworkdayjobs.com', ['*.myworkdayjobs.com'])).toBe(
      true,
    );
    // The classic boundary attack: a prefix-glued lookalike must NOT match.
    expect(hostMatchesAllowlist('evil-myworkdayjobs.com', ['*.myworkdayjobs.com'])).toBe(false);
    // The bare apex must NOT match (the wildcard requires at least one label).
    expect(hostMatchesAllowlist('myworkdayjobs.com', ['*.myworkdayjobs.com'])).toBe(false);
    // A different registrable domain must NOT match.
    expect(
      hostMatchesAllowlist('absa.wd3.myworkdayjobs.com.evil.com', ['*.myworkdayjobs.com']),
    ).toBe(false);
  });

  it('compares case-insensitively for both exact and wildcard patterns', () => {
    expect(hostMatchesAllowlist('ABSA.WD3.MYWORKDAYJOBS.COM', ['*.myworkdayjobs.com'])).toBe(true);
    expect(hostMatchesAllowlist('JOBS.SMARTRECRUITERS.COM', ['jobs.smartrecruiters.com'])).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// assertAllowedApplyHost — the per-source apply-URL guard.
// ---------------------------------------------------------------------------

describe('assertAllowedApplyHost', () => {
  it('has an allowlist entry for every registered source', () => {
    for (const source of SOURCES) {
      expect(APPLY_HOST_ALLOWLIST[source]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('returns the url unchanged for an allowlisted https host', () => {
    const url =
      'https://absa.wd3.myworkdayjobs.com/ABSAcareersite/job/Lydenburg/Adviser_R-15987866';
    expect(assertAllowedApplyHost('absa', url)).toBe(url);
  });

  it('accepts an allowlisted host regardless of hostname case', () => {
    // URL parsing lowercases the hostname, so an upper/mixed-case host still matches.
    expect(() =>
      assertAllowedApplyHost(
        'standardbank',
        'https://JOBS.SmartRecruiters.COM/StandardBankGroup/1',
      ),
    ).not.toThrow();
  });

  it('rejects an http:// (non-https) apply link even on the right host', () => {
    expect(() => assertAllowedApplyHost('absa', 'http://absa.wd3.myworkdayjobs.com/x')).toThrow(
      /https/,
    );
  });

  it('rejects an unknown/typo source with no allowlist entry', () => {
    expect(() =>
      assertAllowedApplyHost('acme-bank' as SourceId, 'https://absa.wd3.myworkdayjobs.com/x'),
    ).toThrow(/unknown source/);
  });

  it('rejects a foreign host for a known source', () => {
    expect(() => assertAllowedApplyHost('absa', 'https://evil.example.com/phish')).toThrow(
      /not allowlisted/,
    );
  });

  it('rejects the userinfo trick — hostname parsing sees evil.com, not the prefix', () => {
    // `https://<allowed>@evil.com/` — the allowed string is userinfo; host is evil.com.
    expect(() =>
      assertAllowedApplyHost('absa', 'https://absa.wd3.myworkdayjobs.com@evil.com/x'),
    ).toThrow(/evil\.com/);
    // A userinfo credential pair form resolves the same way.
    expect(() => assertAllowedApplyHost('absa', 'https://user:pass@evil.com/x')).toThrow(
      /not allowlisted/,
    );
  });

  it('rejects the suffix-append trick (<allowed>.evil.com)', () => {
    expect(() =>
      assertAllowedApplyHost('absa', 'https://absa.wd3.myworkdayjobs.com.evil.com/x'),
    ).toThrow(/not allowlisted/);
  });

  it('names the source, the offending host and the allowed hosts, but never the query string', () => {
    let message = '';
    try {
      assertAllowedApplyHost('absa', 'https://evil.example.com/phish?token=SECRET-CANDIDATE-ID');
      expect.unreachable('guard should have thrown');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('absa'); // the source
    expect(message).toContain('evil.example.com'); // the offending host
    expect(message).toContain('absa.wd3.myworkdayjobs.com'); // the allowed host(s)
    // The path may appear, but the query string (candidate-identifying tokens) must not.
    expect(message).not.toContain('token=');
    expect(message).not.toContain('SECRET-CANDIDATE-ID');
  });

  it('rejects an unparseable apply URL', () => {
    expect(() => assertAllowedApplyHost('absa', 'not a url')).toThrow(/parseable/);
  });
});
