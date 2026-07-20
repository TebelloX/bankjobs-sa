import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The single narrow seam every ingest module talks to. Today it wraps Node's
 * `node:sqlite` `DatabaseSync`; later a `D1HttpDriver` will implement the same
 * shape so the diff/snapshot logic runs unchanged against Cloudflare D1.
 */
export interface JobsDb {
  exec(sql: string): void;
  all<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | undefined;
  run(sql: string, params?: unknown[]): { changes: number };
  transaction<T>(fn: () => T): T;
  close(): void;
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

function wrap(raw: DatabaseSync): JobsDb {
  return {
    exec(sql: string): void {
      raw.exec(sql);
    },
    all<T>(sql: string, params?: unknown[]): T[] {
      return raw.prepare(sql).all(...toParams(params)) as unknown as T[];
    },
    get<T>(sql: string, params?: unknown[]): T | undefined {
      return raw.prepare(sql).get(...toParams(params)) as unknown as T | undefined;
    },
    run(sql: string, params?: unknown[]): { changes: number } {
      const res = raw.prepare(sql).run(...toParams(params));
      return { changes: Number(res.changes) };
    },
    transaction<T>(fn: () => T): T {
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close(): void {
      raw.close();
    },
  };
}

/**
 * Open a local SQLite database, applying `db/schema.sql` when the `jobs` table
 * is absent (so a fresh file — and `':memory:'` — is bootstrapped on first use).
 */
export function openLocalDb(path: string): JobsDb {
  const db = wrap(new DatabaseSync(path));
  const present = db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='jobs'",
  );
  if (!present || present.n === 0) {
    db.exec(loadSchema());
  }
  return db;
}

/**
 * Open the database for an ingest run. A dry run against a not-yet-created file
 * uses an ephemeral in-memory database so nothing is ever written to disk.
 */
export function openIngestDb(dbPath: string, dryRun: boolean): JobsDb {
  if (dryRun && !existsSync(dbPath)) return openLocalDb(':memory:');
  return openLocalDb(dbPath);
}
