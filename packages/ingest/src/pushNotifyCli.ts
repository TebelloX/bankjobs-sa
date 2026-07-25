import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describeError } from '@bankjobs/core';
import { openLocalDb, repoRoot } from './db';
import type { JobsDb } from './db';
import { openD1Db } from './d1http';
import { runPushNotify } from './pushNotify';

/** Same default as the ingest CLI, so both commands read the same local file. */
const DEFAULT_DB = 'db/local.db';

const HELP = `bankjobs push-notify — send one web-push digest for this run's new vacancies.

Usage:
  pnpm --filter @bankjobs/ingest run push-notify -- [options]

Options:
  --remote            Read the production Cloudflare D1 database over the D1
                      REST API instead of a local file. Requires env vars
                      CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
                      CLOUDFLARE_D1_DATABASE_ID. Mutually exclusive with --db.
  --db=<path>         SQLite file (relative to repo root). Default: db/local.db
  --dry-run           Report what would be sent; write nothing, send nothing.
                      The only mode that doesn't need VAPID_PRIVATE_KEY.
  --help              Show this help.

Environment:
  VAPID_PRIVATE_KEY   Private half of the VAPID pair (the public half lives in
                      @bankjobs/core). Required unless --dry-run.

Examples:
  pnpm --filter @bankjobs/ingest run push-notify -- --dry-run
  pnpm --filter @bankjobs/ingest run push-notify -- --remote
`;

/**
 * Open the production D1 seam from the CLOUDFLARE_* env vars and confirm the
 * three tables this command touches are present — the same guard the ingest CLI
 * applies, since a remote D1 is never bootstrapped from here. On any problem it
 * calls `fail` (setting exit 1) and resolves undefined.
 */
async function openRemoteDb(fail: (msg: string) => undefined): Promise<JobsDb | undefined> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (!apiToken || !accountId || !databaseId) {
    const missing: string[] = [];
    if (!apiToken) missing.push('CLOUDFLARE_API_TOKEN');
    if (!accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!databaseId) missing.push('CLOUDFLARE_D1_DATABASE_ID');
    return fail(`--remote requires environment variable(s): ${missing.join(', ')}`);
  }
  const db = openD1Db({ accountId, databaseId, apiToken });

  // Doubles as the connectivity probe: an unreachable or misconfigured D1
  // throws out of here, which is the one class of failure this command exits
  // non-zero on (runPushNotify itself never throws).
  const present = await db.get<{ n: number }>(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='table'
       AND name IN ('jobs', 'push_state', 'push_subscriptions')`,
  );
  if (!present || present.n < 3) {
    await db.close();
    return fail('remote D1 database is missing the jobs/push tables — apply the schema first.');
  }
  return db;
}

async function main(): Promise<void> {
  // `pnpm ... run push-notify -- <args>` can forward a literal `--` into argv;
  // strip leading separators so parseArgs sees only real options.
  let args = process.argv.slice(2);
  while (args[0] === '--') args = args.slice(1);

  const { values } = parseArgs({
    args,
    options: {
      remote: { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const dryRun = values['dry-run'];
  const fail = (msg: string): undefined => {
    process.stderr.write(`${msg}\n`);
    process.exitCode = 1;
    return undefined;
  };

  // A dry run never signs anything, so it's the one mode that runs without the
  // key — handy for checking connectivity and the pending count from a laptop.
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? '';
  if (!dryRun && vapidPrivateKey === '') {
    return fail('push-notify requires environment variable VAPID_PRIVATE_KEY (or --dry-run).');
  }

  let db: JobsDb;
  if (values.remote) {
    // parseArgs can't distinguish a default --db from an explicit one, so treat
    // "value differs from the default" as explicit; remote and a local file are
    // mutually exclusive sources of both the jobs and the subscriptions.
    if (values.db !== DEFAULT_DB) {
      return fail('--remote and --db are mutually exclusive targets.');
    }
    const opened = await openRemoteDb(fail);
    if (!opened) return;
    db = opened;
  } else {
    const dbPath = isAbsolute(values.db) ? values.db : join(repoRoot(), values.db);
    // openLocalDb would bootstrap an empty schema here, and a digest computed
    // from an empty ledger is meaningless — require a populated file instead.
    if (!existsSync(dbPath)) {
      return fail(`no database at ${dbPath} — run an ingest first to populate it.`);
    }
    db = openLocalDb(dbPath);
  }

  try {
    // Exit stays 0 whatever this reports: failed sends are logged, and a push
    // outage must never re-run (or redden) the publish it's attached to.
    await runPushNotify(db, {
      vapidPrivateKey,
      dryRun,
      log: (msg) => process.stdout.write(`${msg}\n`),
    });
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  // A stack omits the cause chain, where undici hides every network-level
  // reason (connect timeout, DNS, TLS) — print it separately when present.
  if (err instanceof Error && err.cause !== undefined) {
    process.stderr.write(`caused by: ${describeError(err.cause)}\n`);
  }
  process.exitCode = 1;
});
