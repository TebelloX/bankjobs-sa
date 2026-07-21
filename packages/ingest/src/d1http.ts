import type { JobsDb } from './db';

/**
 * The D1 REST driver: the second `JobsDb` implementation, letting the ingest
 * pipeline write to the production Cloudflare D1 database over HTTP so a GitHub
 * Actions cron can run it. It speaks the same seam as the local `node:sqlite`
 * wrapper, so diff/snapshot logic is target-agnostic.
 */

export interface D1Options {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Base backoff between retries, doubling each attempt. Kept tiny in tests. */
  retryDelayMs?: number;
}

interface D1QueryResult {
  results: Record<string, unknown>[];
  meta: { changes?: number; last_row_id?: number };
  success: boolean;
}

interface D1Response {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: D1QueryResult[];
}

/** Additional attempts after the first, so 4 HTTP requests at most. */
const MAX_RETRIES = 3;
/** Ceiling on an honoured `Retry-After`, so a hostile header can't stall a run. */
const MAX_RETRY_AFTER_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A short, flattened SQL prefix for error messages. Params are deliberately
 * never included — they can carry full job HTML, and errors get logged.
 */
function sqlPrefix(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function backoffMs(base: number, attempt: number): number {
  return base * 2 ** attempt;
}

/** Honour `Retry-After` (seconds), capped; otherwise fall back to exponential backoff. */
function retryDelay(res: Response, base: number, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return backoffMs(base, attempt);
}

export function openD1Db(opts: D1Options): JobsDb {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseDelay = opts.retryDelayMs ?? 1000;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`;

  /**
   * POST one statement to the D1 query endpoint and return its single result.
   *
   * Retries network rejections, HTTP 429 and HTTP 5xx up to `MAX_RETRIES` more
   * times; any other 4xx (bad SQL, auth, quota) is unfixable by retrying and
   * throws at once. CAVEAT: a retried INSERT whose first attempt actually
   * committed reappears as a UNIQUE-constraint failure — the run is marked
   * failed and the next scheduled run self-heals, since the lifecycle refresh
   * finds the already-inserted row.
   */
  async function query(sql: string, params?: unknown[]): Promise<D1QueryResult> {
    const body = JSON.stringify(params && params.length > 0 ? { sql, params } : { sql });
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            'Content-Type': 'application/json',
          },
          body,
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(baseDelay, attempt));
          attempt += 1;
          continue;
        }
        throw err;
      }

      if (res.ok) {
        return unwrap((await res.json()) as D1Response, sql);
      }

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(retryDelay(res, baseDelay, attempt));
        attempt += 1;
        continue;
      }
      throw new Error(`D1 HTTP ${res.status} for SQL "${sqlPrefix(sql)}"`);
    }
  }

  /**
   * Pull the single statement result out of a D1 response, throwing with the D1
   * error code+message when the batch or its entry reports failure.
   */
  function unwrap(payload: D1Response, sql: string): D1QueryResult {
    const entry = payload.result?.[0];
    if (!payload.success || entry === undefined || entry.success === false) {
      const err = payload.errors?.[0];
      const detail = err ? `[${err.code}] ${err.message}` : 'no error detail returned';
      throw new Error(`D1 query failed (${detail}) for SQL "${sqlPrefix(sql)}"`);
    }
    return entry;
  }

  return {
    async exec(sql: string): Promise<void> {
      await query(sql);
    },
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await query(sql, params)).results as unknown as T[];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
      const { results } = await query(sql, params);
      return (results[0] as unknown as T | undefined) ?? undefined;
    },
    async run(
      sql: string,
      params?: unknown[],
    ): Promise<{ changes: number; lastInsertRowid: number | null }> {
      const { meta } = await query(sql, params);
      return { changes: meta.changes ?? 0, lastInsertRowid: meta.last_row_id ?? null };
    },
    // The D1 REST API has no interactive transactions — every statement
    // auto-commits — so this is a straight passthrough. The diff flow is
    // designed idempotent, so a mid-run crash is healed by the next run.
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async close(): Promise<void> {},
  };
}
