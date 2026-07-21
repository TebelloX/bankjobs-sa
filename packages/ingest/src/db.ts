import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The single narrow seam every ingest module talks to. Its methods are async so
 * one implementation can wrap Node's synchronous `node:sqlite` `DatabaseSync`
 * (resolving immediately) while another — `openD1Db` — speaks the Cloudflare D1
 * REST API over `fetch`; the diff/snapshot logic then runs unchanged against
 * either target.
 */
export interface JobsDb {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(
    sql: string,
    params?: unknown[],
  ): Promise<{ changes: number; lastInsertRowid: number | null }>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Absolute path to the monorepo root, derived from this file's own location. */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function loadSchema(): string {
  return readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8');
}

type SqlParam = string | number | bigint | null | Uint8Array;

function toParams(params?: unknown[]): SqlParam[] {
  return (params ?? []) as SqlParam[];
}

/**
 * Wrap a synchronous `DatabaseSync` in the async `JobsDb` shape. The internals
 * stay sync and every method returns an already-resolved promise; the async
 * signature exists only so remote (D1) callers await the same seam.
 */
function wrap(raw: DatabaseSync): JobsDb {
  return {
    async exec(sql: string): Promise<void> {
      raw.exec(sql);
    },
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return raw.prepare(sql).all(...toParams(params)) as unknown as T[];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
      return raw.prepare(sql).get(...toParams(params)) as unknown as T | undefined;
    },
    async run(
      sql: string,
      params?: unknown[],
    ): Promise<{ changes: number; lastInsertRowid: number | null }> {
      const res = raw.prepare(sql).run(...toParams(params));
      return {
        changes: Number(res.changes),
        lastInsertRowid: res.lastInsertRowid == null ? null : Number(res.lastInsertRowid),
      };
    },
    // BEGIN/COMMIT/ROLLBACK is safe here because ingest runs its sources
    // sequentially, so these transactions never nest or interleave.
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      raw.exec('BEGIN');
      try {
        const result = await fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async close(): Promise<void> {
      raw.close();
    },
  };
}

/**
 * Open a local SQLite database, applying `db/schema.sql` when the `jobs` table
 * is absent (so a fresh file — and `':memory:'` — is bootstrapped on first use).
 * The bootstrap probe reads the raw handle directly, keeping this a synchronous
 * constructor even though the returned seam is async.
 */
export function openLocalDb(path: string): JobsDb {
  const raw = new DatabaseSync(path);
  const present = raw
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { n: number } | undefined;
  if (!present || present.n === 0) {
    raw.exec(loadSchema());
  }
  return wrap(raw);
}

/**
 * Open the database for an ingest run. A dry run against a not-yet-created file
 * uses an ephemeral in-memory database so nothing is ever written to disk.
 */
export function openIngestDb(dbPath: string, dryRun: boolean): JobsDb {
  if (dryRun && !existsSync(dbPath)) return openLocalDb(':memory:');
  return openLocalDb(dbPath);
}
