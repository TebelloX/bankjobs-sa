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
