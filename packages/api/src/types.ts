/** Worker bindings. `DB` is the D1 database (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  /** Version-metadata binding; absent in runtimes that don't provide it (the
   *  test pool, older local dev) — cache keys then simply omit the version. */
  VERSION?: { id: string };
}
