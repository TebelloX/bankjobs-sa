import type { CanonicalJob, SourceId } from '@bankjobs/core';

/** Options threaded through every adapter/client network call. */
export interface FetchOptions {
  /** Injectable fetch (tests stub this; defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Progress sink for human-readable log lines. */
  log?: (msg: string) => void;
}

/**
 * A source adapter turns a bank's raw postings into CanonicalJobs.
 * `fetchAll` is the only network-touching method; `normalize` is pure so it can
 * be exercised directly against committed fixtures.
 */
export interface SourceAdapter<Raw> {
  source: SourceId;
  fetchAll(opts?: FetchOptions): Promise<Raw[]>;
  /** Pure. Throws {@link AdapterNormalizeError} on malformed input. */
  normalize(raw: Raw): CanonicalJob;
}

/**
 * Thrown by `normalize` when a raw posting is missing fields we cannot invent
 * (e.g. the requisition id or apply URL). Carries the source plus a best-effort
 * identifier for the offending record so callers can log/skip it precisely.
 */
export class AdapterNormalizeError extends Error {
  readonly source: SourceId;
  readonly identifier: string;

  constructor(source: SourceId, identifier: string, reason: string) {
    super(`[${source}] normalize failed for ${identifier}: ${reason}`);
    this.name = 'AdapterNormalizeError';
    this.source = source;
    this.identifier = identifier;
  }
}
