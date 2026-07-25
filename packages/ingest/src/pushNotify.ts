// web-push is CommonJS and hands out its functions as properties of one object
// literal, which cjs-module-lexer can't see through: under Node's ESM loader
// `import { sendNotification } from 'web-push'` typechecks and then resolves to
// undefined at runtime. The default import (the whole module.exports) is the one
// form that behaves identically under Node and under vitest's interop.
import webpush from 'web-push';
import { VAPID_PUBLIC_KEY, describeError } from '@bankjobs/core';
import type { JobsDb } from './db';

/**
 * The digest sender: at most ONE push notification per ingest run, to every
 * stored subscription, carrying only a count — "3 new bank vacancies in South
 * Africa". Node-only (it runs in the Actions workflow after the site publish);
 * nothing here is ever bundled into the site or the Worker, because the VAPID
 * private key it signs with must never leave CI.
 *
 * Everything hangs off a single row in `push_state`: the highest `first_seen`
 * a digest has already covered. Jobs newer than the watermark are the digest;
 * the watermark then moves to the newest of them. Re-running the sender right
 * after a successful run therefore finds nothing new and sends nothing.
 */

/** The single `push_state` row this module owns. */
const WATERMARK_KEY = 'last_notified_first_seen';

/** VAPID `sub` claim — a contact the push service can reach if we misbehave. */
const SUBJECT = 'mailto:tebellonamo@gmail.com';

/** Where a tapped notification lands. */
const DIGEST_URL = 'https://mybankjobs.co.za/vacancies/';

/**
 * Six hours. The next scheduled run supersedes this digest, so a phone that was
 * off overnight should get the one current notification on waking, not three
 * stale ones queued behind each other.
 */
const TTL_SECONDS = 21600;

/**
 * How many sends are in flight at once. Small on purpose: the subscriber list is
 * tiny, push services rate-limit, and a plain chunked loop keeps this dependency
 * -free (no p-limit).
 */
const SEND_CHUNK = 5;

export interface PushNotifyOptions {
  /** The private half of the VAPID pair; the public half comes from core. */
  vapidPrivateKey: string;
  /** ISO instant, injectable for tests. Only used to seed an empty ledger. */
  now?: string;
  /** Report what would happen; write nothing, send nothing. */
  dryRun?: boolean;
  /** Injectable sender so tests never touch the network. */
  send?: typeof webpush.sendNotification;
  /** Defaults to stdout, matching the ingest CLI's logging seam. */
  log?: (msg: string) => void;
}

export interface PushNotifySummary {
  /** Open SA jobs newer than the watermark — the number in the digest body. */
  newJobs: number;
  /** Subscriptions loaded (before pruning). */
  subscribers: number;
  sent: number;
  /** Rows deleted because the push service reported the endpoint gone. */
  pruned: number;
  /** Sends that failed for any other reason; those rows are kept. */
  failed: number;
  /** The watermark `push_state` holds when this run returns — null if unset. */
  watermark: string | null;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * A push service saying "this endpoint is gone" — 404 (never existed) or 410
 * (expired/unsubscribed). Both are permanent, so the row is deleted. Duck-typed
 * rather than `instanceof WebPushError` so an injected sender's error works too.
 */
function goneStatus(err: unknown): number | undefined {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

function digestBody(n: number): string {
  return `${n} new bank ${n === 1 ? 'vacancy' : 'vacancies'} in South Africa`;
}

/**
 * Send one digest covering every open SA job first seen after the stored
 * watermark, then move the watermark past them.
 *
 * NEVER throws: a push outage (or a malformed key, or D1 going away mid-run)
 * must not fail the workflow run it's attached to — the site is already
 * published by then. Every failure is logged and folded into the summary.
 */
export async function runPushNotify(
  db: JobsDb,
  opts: PushNotifyOptions,
): Promise<PushNotifySummary> {
  const log = opts.log ?? ((msg: string): void => void process.stdout.write(`${msg}\n`));
  const dryRun = opts.dryRun ?? false;
  const send = opts.send ?? webpush.sendNotification;
  const summary: PushNotifySummary = {
    newJobs: 0,
    subscribers: 0,
    sent: 0,
    pruned: 0,
    failed: 0,
    watermark: null,
  };

  try {
    const state = await db.get<{ value: string }>('SELECT value FROM push_state WHERE key = ?', [
      WATERMARK_KEY,
    ]);

    // First ever run: adopt the newest job in the ledger as the watermark and
    // send NOTHING. Without this, the first deploy would greet every subscriber
    // with a digest of the entire back catalogue.
    if (state === undefined) {
      const newest = await db.get<{ mx: string | null }>('SELECT MAX(first_seen) AS mx FROM jobs');
      const mark = newest?.mx ?? opts.now ?? new Date().toISOString();
      if (dryRun) {
        log(`push: dry-run — would initialize watermark at ${mark}, nothing sent`);
        return summary;
      }
      await db.run('INSERT INTO push_state (key, value) VALUES (?, ?)', [WATERMARK_KEY, mark]);
      summary.watermark = mark;
      log(`push: watermark initialized at ${mark} — nothing sent`);
      return summary;
    }

    const watermark = state.value;
    summary.watermark = watermark;

    // The digest population. `hidden` and `closed` roles are off the statement,
    // and international postings never belong in an "in South Africa" count.
    const counted = await db.get<{ n: number; mx: string | null }>(
      `SELECT COUNT(*) AS n, MAX(first_seen) AS mx FROM jobs
         WHERE country = 'ZA' AND status = 'open' AND first_seen > ?`,
      [watermark],
    );
    const newJobs = Number(counted?.n ?? 0);
    const mx = counted?.mx ?? null;
    summary.newJobs = newJobs;
    if (newJobs === 0 || mx === null) {
      log(`push: nothing new since ${watermark} — no digest`);
      return summary;
    }

    const advance = async (): Promise<void> => {
      if (dryRun) return;
      await db.run('UPDATE push_state SET value = ? WHERE key = ?', [mx, WATERMARK_KEY]);
      summary.watermark = mx;
    };

    const subs = await db.all<SubscriptionRow>(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions',
    );
    summary.subscribers = subs.length;

    // Nobody subscribed yet, but the watermark still moves: the first real
    // digest should cover what lands AFTER someone subscribes, not everything
    // that accumulated while the list was empty.
    if (subs.length === 0) {
      await advance();
      log(
        `push: ${newJobs} new job(s), no subscribers — watermark ${dryRun ? 'would advance' : 'advanced'} to ${mx}`,
      );
      return summary;
    }

    const payload = JSON.stringify({
      title: 'mybankjobs',
      body: digestBody(newJobs),
      url: DIGEST_URL,
    });

    if (dryRun) {
      log(
        `push: dry-run — would send "${digestBody(newJobs)}" to ${subs.length} subscriber(s) and advance the watermark to ${mx}`,
      );
      return summary;
    }

    webpush.setVapidDetails(SUBJECT, VAPID_PUBLIC_KEY, opts.vapidPrivateKey);

    for (let i = 0; i < subs.length; i += SEND_CHUNK) {
      const chunk = subs.slice(i, i + SEND_CHUNK);
      await Promise.all(
        chunk.map(async (sub) => {
          try {
            await send(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
              { TTL: TTL_SECONDS },
            );
            summary.sent += 1;
          } catch (err) {
            const status = goneStatus(err);
            if (status === 404 || status === 410) {
              await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
              summary.pruned += 1;
              log(`push: pruned gone subscription (HTTP ${status})`);
              return;
            }
            summary.failed += 1;
            // The endpoint itself is never logged — it's the whole credential
            // for pushing to that browser.
            log(`push: send failed (${status ?? 'no status'}): ${describeError(err)}`);
          }
        }),
      );
    }

    // Deliberately AFTER the sends: a crash between the loop and this update
    // leaves the watermark where it was, so the next run re-sends a digest
    // covering the same jobs. A duplicate digest is the safe failure; silently
    // skipping the only notification those jobs will ever get is not.
    await advance();

    log(
      `push: ${newJobs} new job(s) → ${summary.sent} sent, ${summary.pruned} pruned, ${summary.failed} failed; watermark ${mx}`,
    );
    return summary;
  } catch (err) {
    log(`push: ERROR — ${describeError(err)}`);
    return summary;
  }
}
