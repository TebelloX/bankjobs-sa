import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { openIngestDb, repoRoot } from './db';
import { resolveSources } from './registry';
import { runIngest } from './run';

const HELP = `bankjobs ingest — fetch, diff and snapshot bank job listings.

Usage:
  pnpm ingest -- [options]

Options:
  --source=<id>       Source to run (repeatable). Default: all enabled sources
                      that have an adapter.
  --dry-run           Fetch and report only; write nothing to the DB or disk.
  --fixtures          Use committed fixtures instead of the network (offline/CI).
  --db=<path>         SQLite file (relative to repo root). Default: db/local.db
  --snapshot-dir=<p>  Output dir for snapshots (relative to repo root). Default: site
  --help              Show this help.

Examples:
  pnpm ingest -- --source=absa --dry-run
  pnpm ingest -- --source=absa
  pnpm ingest -- --source=absa --fixtures
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
      db: { type: 'string', default: 'db/local.db' },
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
  const dbPath = resolvePath(values.db);
  const snapshotDir = resolvePath(values['snapshot-dir']);
  const dryRun = values['dry-run'];
  const fixtures = values.fixtures;

  const db = openIngestDb(dbPath, dryRun);
  let sources;
  try {
    sources = resolveSources(values.source, db);
  } finally {
    db.close();
  }

  if (sources.length === 0) {
    process.stderr.write('No sources to run (none enabled with an adapter, or none requested).\n');
    process.exitCode = 1;
    return;
  }

  const code = await runIngest({
    sources,
    dryRun,
    fixtures,
    dbPath,
    snapshotDir,
    log: (msg) => process.stdout.write(`${msg}\n`),
  });
  process.exitCode = code;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
