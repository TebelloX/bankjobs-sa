import { ensureIngestRun } from './watchdog';

interface Env {
  GITHUB_TOKEN: string;
}

export default {
  // Throwing (bad token, GitHub API down) marks the cron invocation failed in
  // the Cloudflare dashboard's event log — the only observability this Worker
  // needs. The log line below shows up there and in `wrangler tail`.
  async scheduled(controller, env, _ctx) {
    const outcome = await ensureIngestRun({
      token: env.GITHUB_TOKEN,
      now: new Date(controller.scheduledTime),
      fetchImpl: fetch,
    });
    console.log(`ingest watchdog: ${outcome}`);
  },
} satisfies ExportedHandler<Env>;
