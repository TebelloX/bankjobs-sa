export interface GuardrailResult {
  ok: boolean;
  reason?: string;
}

/**
 * Cheap anomaly check run before any closures happen. Trips when a source
 * returns nothing, or when its count collapses to under half of the last
 * successful run (a classic sign of an endpoint change or partial outage).
 * With no prior successful run there is no baseline, so only the zero check
 * applies — this keeps the very first run from being flagged.
 */
export function checkAnomaly(seenCount: number, lastSuccessSeen: number | null): GuardrailResult {
  if (seenCount === 0) {
    return { ok: false, reason: 'source returned zero jobs' };
  }
  if (lastSuccessSeen != null && seenCount < 0.5 * lastSuccessSeen) {
    return { ok: false, reason: `count dropped >50%: ${seenCount} vs ${lastSuccessSeen}` };
  }
  return { ok: true };
}
