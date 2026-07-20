import type { CanonicalJob, SourceId } from '@bankjobs/core';
import type { FetchOptions } from '@bankjobs/adapters';
import { adapters } from '@bankjobs/adapters';
import type { JobsDb } from './db';

/**
 * A source adapter with its raw type erased, so heterogeneous adapters can live
 * in one registry keyed by `SourceId`. `normalize` takes `any` because the raw
 * value comes straight back from the same adapter's `fetchAll` — the pairing is
 * enforced at runtime by the registry lookup, not by the type system.
 */
export interface AnyAdapter {
  source: SourceId;
  fetchAll(opts?: FetchOptions): Promise<unknown[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalize(raw: any): CanonicalJob;
}

/** Adapter registry — currently Absa only. */
export const registry = adapters as unknown as Partial<Record<SourceId, AnyAdapter>>;

/**
 * Decide which sources to run.
 * - No request → every source that is `enabled` in the DB and has an adapter.
 * - Explicit request → exactly those, after validating each name is known
 *   (i.e. has an adapter); throws on the first unknown name.
 */
export function resolveSources(requested: string[] | undefined, db: JobsDb): SourceId[] {
  const known = Object.keys(registry) as SourceId[];

  if (requested === undefined) {
    const enabled = new Set(
      db.all<{ id: string }>('SELECT id FROM sources WHERE enabled = 1').map((r) => r.id),
    );
    return known.filter((id) => enabled.has(id));
  }

  const knownSet = new Set<string>(known);
  const result: SourceId[] = [];
  for (const name of requested) {
    if (!knownSet.has(name)) {
      throw new Error(`unknown source '${name}' (known: ${known.join(', ') || 'none'})`);
    }
    result.push(name as SourceId);
  }
  return result;
}
