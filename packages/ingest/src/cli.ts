import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { openIngestDb, repoRoot } from './db';
import type { JobsDb } from './db';
import { openD1Db } from './d1http';
import { resolveSources } from './registry';
import { runIngest } from './run';

/** Kept in sync with the parseArgs default so cli can spot an explicit --db. */
const DEFAULT_DB = 'db/local.db';

const HELP = `bankjobs ingest — fetch, diff and snapshot bank job listings.

Usage:
  pnpm ingest -- [options]

Options:
  --source=<id>       Source to run (repeatable). Default: all enabled sources
                      that have an adapter.
  --dry-run           Fetch and report only; write nothing to the DB or disk.
  --fixtures          Use committed fixtures instead of the network (offline/CI).
  --db=<path>         SQLite file (relative to repo root). Default: db/local.db
  --remote            Write to the production Cloudflare D1 database over the D1
                      REST API instead of a local file. Requires env vars
                      CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
                      CLOUDFLARE_D1_DATABASE_ID. Skips site snapshots. Mutually
                      exclusive with --db; --fixtures needs --dry-run with it.
  --snapshot-dir=<p>  Output dir for snapshots (relative to repo root). Default: site
  --help              Show this help.

Examples:
  pnpm ingest -- --source=absa --dry-run
  pnpm ingest -- --source=absa
  pnpm ingest -- --source=absa --fixtures
  pnpm ingest -- --remote
  pnpm ingest -- --remote --dry-run   # zero-write connectivity check
`;

async function main(): Promise<void> {
  // `pnpm ingest -- <args>` forwards a literal `--` into argv through the nested
  // run; strip leading separators so parseArgs sees only real options.
  let args = process.argv.slice(2);
  while (args[0] === '--') args = args.slice(1);

  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      fixtures: { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB },
      remote: { type: 'boolean', default: false },
      'snapshot-dir': { type: 'string', default: 'site' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const root = repoRoot();
  const resolvePath = (p: string): string => (isAbsolute(p) ? p : join(root, p));
  const snapshotDir = resolvePath(values['snapshot-dir']);
  const dryRun = values['dry-run'];
  const fixtures = values.fixtures;
  const remote = values.remote;

  const fail = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
    process.exitCode = 1;
  };

  let db: JobsDb;
  if (remote) {
    // parseArgs can't distinguish a default --db from an explicit one, so treat
    // "value differs from the default" as explicit; a remote and a local file
    // are mutually exclusive write targets.
    if (values.db !== DEFAULT_DB) {
      return fail('--remote and --db are mutually exclusive targets.');
    }
    // Replaying committed fixtures against production would CLOSE every live job
    // the fixtures don't contain. Only permit it as a zero-write dry run, which
    // is a useful connectivity check.
    if (fixtures && !dryRun) {
      return fail(
        '--remote --fixtures would close every live job not in the fixtures; add --dry-run for a read-only connectivity check.',
      );
    }
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
    db = openD1Db({ accountId, databaseId, apiToken });

    // Unlike openLocalDb, a remote D1 is never bootstrapped from here — its
    // schema must already be applied. Bail early with a clear message otherwise.
    const present = await db.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='jobs'",
    );
    if (!present || present.n === 0) {
      await db.close();
      return fail('remote D1 database has no schema — apply db/schema.sql first.');
    }
  } else {
    db = openIngestDb(resolvePath(values.db), dryRun);
  }

  // The db is opened exactly once. runIngest closes it in its finally; on any
  // path that errors before we hand off to runIngest, we close it ourselves.
  let sources;
  try {
    sources = await resolveSources(values.source, db);
  } catch (err) {
    await db.close();
    throw err;
  }

  if (sources.length === 0) {
    await db.close();
    return fail('No sources to run (none enabled with an adapter, or none requested).');
  }

  const code = await runIngest({
    sources,
    dryRun,
    fixtures,
    db,
    snapshots: !remote,
    snapshotDir,
    log: (msg) => process.stdout.write(`${msg}\n`),
  });
  process.exitCode = code;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
