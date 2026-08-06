// GitHub-cron watchdog for ingest.yml. GitHub's schedule trigger is
// best-effort — the 04:00 UTC slot on 22 Jul 2026 simply never fired, and
// moving off :00 only made drops rarer, not impossible. Cloudflare cron
// delivery is reliable, so this Worker fires 18 minutes after each ingest
// slot, asks the GitHub API whether a run was actually created, and
// dispatches one (workflow_dispatch — ingest.yml already accepts it with
// all-source defaults) only when the slot was dropped.
//
// Deliberately NOT retry-on-failure: a run that started and went red is a
// human's signal in the Actions tab; re-dispatching would bury it. The
// watchdog covers exactly one failure mode — "the schedule never fired".
// If a late GitHub cron and the watchdog both create runs, ingest.yml's
// `concurrency: ingest` group queues them and the second diffs to
// all-unchanged — harmless by design.

const OWNER_REPO = 'TebelloX/bankjobs-sa';
const WORKFLOW_FILE = 'ingest.yml';
const API_BASE = `https://api.github.com/repos/${OWNER_REPO}/actions/workflows/${WORKFLOW_FILE}`;

// A run created inside this window counts as "the slot fired" — any event
// type, since a manual dispatch moments before the slot means fresh data too.
// 25 min reaches back past the :02 slot from the :20 firing, with slack for
// GitHub timestamp skew.
export const RECENT_RUN_WINDOW_MS = 25 * 60 * 1000;

export type WatchdogOutcome = 'recent-run-exists' | 'dispatched';

export interface WatchdogDeps {
  token: string;
  now: Date;
  fetchImpl: typeof fetch;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    // GitHub rejects requests without a User-Agent outright.
    'user-agent': 'bankjobs-cron-watchdog',
    'x-github-api-version': '2022-11-28',
  };
}

export async function ensureIngestRun(deps: WatchdogDeps): Promise<WatchdogOutcome> {
  const { token, now, fetchImpl } = deps;

  const listRes = await fetchImpl(`${API_BASE}/runs?per_page=10`, {
    headers: githubHeaders(token),
  });
  if (!listRes.ok) {
    throw new Error(`listing ingest runs failed: HTTP ${listRes.status}`);
  }
  const body = (await listRes.json()) as {
    workflow_runs?: Array<{ created_at?: string }>;
  };
  const runs = body.workflow_runs ?? [];

  const cutoff = now.getTime() - RECENT_RUN_WINDOW_MS;
  const hasRecent = runs.some((run) => {
    const created = Date.parse(run.created_at ?? '');
    return Number.isFinite(created) && created >= cutoff;
  });
  if (hasRecent) return 'recent-run-exists';

  const dispatchRes = await fetchImpl(`${API_BASE}/dispatches`, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (dispatchRes.status !== 204) {
    throw new Error(`workflow_dispatch failed: HTTP ${dispatchRes.status}`);
  }
  return 'dispatched';
}
