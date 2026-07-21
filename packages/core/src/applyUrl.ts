import type { SourceId } from './job';

const EXACT_STRIP = new Set(['fbclid', 'gclid', 'source', 'src']);

/**
 * Remove tracking query parameters from an apply URL:
 * any `utm_*` param plus exactly (case-insensitive) `fbclid`, `gclid`,
 * `source`, and `src`. Returns the input unchanged if it cannot be parsed.
 */
export function cleanApplyUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  const toDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (/^utm_/i.test(key) || EXACT_STRIP.has(lower)) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    url.searchParams.delete(key);
  }

  return url.toString();
}

/**
 * Per-source allowlist of the official host(s) an adapter's `applyUrl` may point
 * at. The apply button is the most trusted element on the site, so a hijacked or
 * compromised upstream feed must never be able to slip a phishing link past it:
 * every host here is the REAL host that source's adapter produces, derived from
 * the committed fixtures + adapter config (Workday tenants, SmartRecruiters,
 * eArcu, Workable, SuccessFactors CSB and Oracle Recruiting Cloud respectively),
 * never guessed.
 *
 * Entries are EXACT hosts by deliberate choice — each source resolves to a single
 * known host today, so an exact match is the tightest guard. Suffix wildcards of
 * the form `*.example.com` are also supported by {@link hostMatchesAllowlist}
 * (dot-anchored; see there) for the day a source legitimately spreads across
 * per-tenant subdomains, but none is needed yet. A bare TLD-wide pattern
 * (`*.com`) is never allowed.
 *
 * The map is keyed by SourceId, so adding a bank without an allowlist entry is a
 * compile error — the guard can never be silently skipped for a new source.
 */
export const APPLY_HOST_ALLOWLIST: Record<SourceId, readonly string[]> = {
  absa: ['absa.wd3.myworkdayjobs.com'],
  firstrand: ['firstrand.wd3.myworkdayjobs.com'],
  standardbank: ['jobs.smartrecruiters.com'],
  investec: ['careers.investec.co.za'],
  gotyme: ['apply.workable.com'],
  nedbank: ['jobs.nedbank.co.za'],
  discovery: ['careers.discovery.co.za'],
  capitec: ['careers.capitecbank.co.za'],
  sarb: ['fa-evra-saasfaprod1.fa.ocs.oraclecloud.com'],
};

/**
 * True when `hostname` matches any of the allowlist `patterns`. Both the host and
 * the patterns are compared case-insensitively (URL hostnames arrive lowercased,
 * but patterns are lowered defensively too).
 *
 * A pattern is either an exact host (`jobs.example.com`) or a suffix wildcard
 * (`*.example.com`). The wildcard is anchored on a DOT boundary and requires at
 * least one label in front, so `a.b.example.com` matches `*.example.com` but the
 * lookalike `evil-example.com` and the bare apex `example.com` do NOT — the
 * anchoring is what defeats the classic `<allowed>.evil.com` / `evil-<allowed>`
 * suffix-confusion attacks.
 */
export function hostMatchesAllowlist(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      if (host.length > base.length + 1 && host.endsWith(`.${base}`)) return true;
    } else if (host === p) {
      return true;
    }
  }
  return false;
}

/**
 * Assert that `url` is a safe, official apply link for `source`, returning it
 * unchanged so it can wrap the finalized apply URL inline
 * (`applyUrl: assertAllowedApplyHost(SOURCE, cleanApplyUrl(raw))`). Throws when:
 *   - `source` has no allowlist entry (an unknown/typo'd source),
 *   - `url` does not parse as a URL,
 *   - the protocol is not `https:` (an `http://` apply link is a downgrade), or
 *   - the parsed hostname is not on the source's allowlist.
 *
 * Parsing via {@link URL} is itself part of the defense: it strips `userinfo`
 * tricks (`https://good.host@evil.com/` parses to hostname `evil.com`) and does
 * not treat a suffix-appended lookalike (`good.host.evil.com`) as the real host.
 *
 * The thrown message names the source, the offending host and the allowed hosts
 * for debuggability, plus the path for context — but never the query string,
 * which can carry candidate-identifying tracking tokens.
 */
export function assertAllowedApplyHost(source: SourceId, url: string): string {
  const allow = APPLY_HOST_ALLOWLIST[source];
  if (!allow) {
    throw new Error(`applyUrl guard: no host allowlist for unknown source '${source}'`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `[${source}] applyUrl is not a parseable URL: ${url.split(/[?#]/, 1)[0] ?? ''}`,
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `[${source}] applyUrl must use https, got '${parsed.protocol}' for ${parsed.hostname}${parsed.pathname}`,
    );
  }

  if (!hostMatchesAllowlist(parsed.hostname, allow)) {
    throw new Error(
      `[${source}] applyUrl host '${parsed.hostname}' is not allowlisted ` +
        `(path ${parsed.pathname}); allowed: ${allow.join(', ')}`,
    );
  }

  return url;
}
