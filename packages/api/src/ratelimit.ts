// Per-IP token bucket, in-memory per isolate. HONEST CAVEAT: state lives in this
// Map and resets whenever the isolate is evicted, and different isolates hold
// independent buckets — so this is best-effort free-tier protection, not a
// global limiter. That matches the plan's "simple" per-IP rate limit; the edge
// cache (checked before the limiter) already absorbs the bulk of read traffic.

const CAPACITY = 20; // burst
const REFILL_PER_SEC = 1; // steady state 60 req/min

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

export interface RateResult {
  allowed: boolean;
  retryAfter: number; // seconds, only meaningful when !allowed
}

export function takeToken(ip: string, now: number = Date.now()): RateResult {
  let bucket = buckets.get(ip);
  if (bucket === undefined) {
    bucket = { tokens: CAPACITY, last: now };
    buckets.set(ip, bucket);
  }
  const elapsedSec = Math.max(0, (now - bucket.last) / 1000);
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedSec * REFILL_PER_SEC);
  bucket.last = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }
  const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / REFILL_PER_SEC));
  return { allowed: false, retryAfter };
}

/** Test-only: clear all buckets so a suite starts from a full quota. */
export function resetRateLimiter(): void {
  buckets.clear();
}
