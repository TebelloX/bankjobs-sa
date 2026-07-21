import type { Env } from './types';

/** The read surface shared by D1Database and D1DatabaseSession. */
export interface Reader {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * Read via the D1 Sessions API for nearest-replica reads (plan §2.6).
 * 'first-unconstrained' starts on any replica with no bookmark constraint — safe
 * because this API never reads-after-write. miniflare/workerd may not implement
 * `withSession`; the production binding always does, so fall back to the bare
 * binding locally. Both branches expose the same `prepare`/`batch` surface.
 */
export function reader(env: Env): Reader {
  const db = env.DB;
  if (typeof db.withSession === 'function') {
    return db.withSession('first-unconstrained');
  }
  return db;
}
