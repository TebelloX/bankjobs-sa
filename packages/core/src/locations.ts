import type { JobLocation, Province } from './job';
import locationData from './data/za-locations.json';

export interface NormalizedLocation extends JobLocation {
  matched: boolean;
}

interface AliasEntry {
  city: string | null;
  province: string | null;
}

const aliases = locationData.aliases as Record<string, AliasEntry>;

// Pre-sort alias keys longest-first so multi-word cities win over their parts.
// On equal length, entries that carry a city win over province-only entries so
// a city token beats a co-located province token (e.g. "Rustenburg, North West").
const sortedAliasKeys = Object.keys(aliases).sort((a, b) => {
  if (b.length !== a.length) return b.length - a.length;
  const aRank = aliases[a]?.city != null ? 0 : 1;
  const bRank = aliases[b]?.city != null ? 0 : 1;
  return aRank - bRank;
});

/** Lowercase, replace punctuation with spaces, collapse whitespace, trim. */
function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toResult(raw: string, entry: AliasEntry): NormalizedLocation {
  return {
    city: entry.city,
    province: entry.province as Province | null,
    raw,
    matched: true,
  };
}

/**
 * Resolve a raw location string to a canonical South African city/province.
 * Never throws; returns `matched: false` (with null city/province) when nothing
 * matches, so non-SA locations fall back to the raw string for display.
 */
export function normalizeLocation(raw: string): NormalizedLocation {
  const normalized = normalizeText(raw);

  if (normalized.length > 0) {
    // 1) exact match
    const exact = aliases[normalized];
    if (exact) return toResult(raw, exact);

    // 2) longest-first substring scan
    for (const key of sortedAliasKeys) {
      if (normalized.includes(key)) {
        const entry = aliases[key];
        if (entry) return toResult(raw, entry);
      }
    }
  }

  return { city: null, province: null, raw, matched: false };
}
