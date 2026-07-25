import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import type { CanonicalJob } from '@bankjobs/core';
import { VAPID_PUBLIC_KEY } from '@bankjobs/core';
import { openLocalDb } from '../src/db';
import type { JobsDb } from '../src/db';
import { upsertJobs } from '../src/diff';
import { runPushNotify } from '../src/pushNotify';

/** Three ingest runs' worth of instants; jobs land on the run that first saw them. */
const DAY1 = '2026-07-01T04:02:00.000Z';
const DAY2 = '2026-07-02T04:02:00.000Z';
const DAY3 = '2026-07-03T04:02:00.000Z';

/**
 * A real 32-byte VAPID private key, generated locally — `setVapidDetails`
 * validates the key's shape (not that it pairs with the public half), so the
 * send path runs exactly as it does in production while every send is injected.
 */
const VAPID_PRIVATE_KEY = webpush.generateVAPIDKeys().privateKey;

function makeJob(overrides: Partial<CanonicalJob>): CanonicalJob {
  return {
    id: 'absa:R-0',
    source: 'absa',
    brand: 'Absa',
    title: 'Job',
    category: 'Other',
    employmentType: 'Full time',
    descriptionHtml: '<p>Work here.</p>',
    descriptionText: 'Work here.',
    excerpt: 'Work here.',
    primaryLocation: null,
    locations: [],
    country: 'ZA',
    applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply',
    postedDate: null,
    ...overrides,
  };
}

/** Insert jobs as an ingest run would, stamping `first_seen` with `now`. */
async function seedJobs(db: JobsDb, now: string, jobs: Partial<CanonicalJob>[]): Promise<void> {
  await upsertJobs(db, 'absa', jobs.map(makeJob), now);
}

async function seedSubscription(db: JobsDb, endpoint: string): Promise<void> {
  await db.run(
    'INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)',
    [endpoint, `p256dh-${endpoint}`, `auth-${endpoint}`, DAY1],
  );
}

async function setWatermark(db: JobsDb, value: string): Promise<void> {
  await db.run("INSERT INTO push_state (key, value) VALUES ('last_notified_first_seen', ?)", [
    value,
  ]);
}

async function readWatermark(db: JobsDb): Promise<string | undefined> {
  const row = await db.get<{ value: string }>(
    "SELECT value FROM push_state WHERE key = 'last_notified_first_seen'",
  );
  return row?.value;
}

async function endpoints(db: JobsDb): Promise<string[]> {
  const rows = await db.all<{ endpoint: string }>(
    'SELECT endpoint FROM push_subscriptions ORDER BY endpoint',
  );
  return rows.map((r) => r.endpoint);
}

/** A resolved send, standing in for a push service that accepted the payload. */
function okSend(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ statusCode: 201, body: '', headers: {} }));
}

/** A push-service rejection, shaped like the WebPushError the real sender throws. */
function pushError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`push service said ${statusCode}`), { statusCode });
}

/** A fresh in-memory ledger plus the log lines the run emitted. */
function harness(): { db: JobsDb; logs: string[]; log: (msg: string) => void } {
  const db = openLocalDb(':memory:');
  const logs: string[] = [];
  return { db, logs, log: (msg) => void logs.push(msg) };
}

describe('runPushNotify', () => {
  it('bootstraps the watermark to the newest job and sends nothing', async () => {
    const { db, logs, log } = harness();
    await seedJobs(db, DAY1, [{ id: 'absa:R-1' }]);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }, { id: 'absa:R-2' }]);
    const send = okSend();

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(send).not.toHaveBeenCalled();
    expect(await readWatermark(db)).toBe(DAY2);
    expect(summary).toEqual({
      newJobs: 0,
      subscribers: 0,
      sent: 0,
      pruned: 0,
      failed: 0,
      watermark: DAY2,
    });
    expect(logs.join('\n')).toContain('watermark initialized');
    await db.close();
  });

  it('bootstraps to `now` when the ledger is empty', async () => {
    const { db, log } = harness();

    await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, now: DAY3, send: okSend(), log });

    expect(await readWatermark(db)).toBe(DAY3);
    await db.close();
  });

  it('sends nothing and leaves the watermark when no job is newer', async () => {
    const { db, logs, log } = harness();
    await seedJobs(db, DAY1, [{ id: 'absa:R-1' }]);
    await setWatermark(db, DAY1);
    await seedSubscription(db, 'https://push.example/a');
    const send = okSend();

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(send).not.toHaveBeenCalled();
    expect(await readWatermark(db)).toBe(DAY1);
    expect(summary.newJobs).toBe(0);
    // The subscription list is never even loaded when there's nothing to say.
    expect(summary.subscribers).toBe(0);
    expect(logs.join('\n')).toContain('nothing new');
    await db.close();
  });

  it('advances the watermark without sending when nobody is subscribed', async () => {
    const { db, logs, log } = harness();
    await seedJobs(db, DAY1, [{ id: 'absa:R-1' }]);
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }, { id: 'absa:R-2' }]);
    const send = okSend();

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(send).not.toHaveBeenCalled();
    expect(await readWatermark(db)).toBe(DAY2);
    expect(summary.newJobs).toBe(1);
    expect(summary.subscribers).toBe(0);
    expect(summary.watermark).toBe(DAY2);
    expect(logs.join('\n')).toContain('no subscribers');
    await db.close();
  });

  it('sends one digest to every subscriber and advances the watermark', async () => {
    const { db, log } = harness();
    await seedJobs(db, DAY1, [{ id: 'absa:R-1' }]);
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }, { id: 'absa:R-2' }, { id: 'absa:R-3' }]);
    await seedSubscription(db, 'https://push.example/a');
    await seedSubscription(db, 'https://push.example/b');
    const send = okSend();

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(send).toHaveBeenCalledTimes(2);
    const payload = JSON.stringify({
      title: 'mybankjobs',
      body: '2 new bank vacancies in South Africa',
      url: 'https://mybankjobs.co.za/vacancies/',
    });
    expect(send).toHaveBeenCalledWith(
      {
        endpoint: 'https://push.example/a',
        keys: { p256dh: 'p256dh-https://push.example/a', auth: 'auth-https://push.example/a' },
      },
      payload,
      { TTL: 21600 },
    );
    expect(send).toHaveBeenCalledWith(
      {
        endpoint: 'https://push.example/b',
        keys: { p256dh: 'p256dh-https://push.example/b', auth: 'auth-https://push.example/b' },
      },
      payload,
      { TTL: 21600 },
    );
    expect(await readWatermark(db)).toBe(DAY2);
    expect(summary).toEqual({
      newJobs: 2,
      subscribers: 2,
      sent: 2,
      pruned: 0,
      failed: 0,
      watermark: DAY2,
    });
    await db.close();
  });

  it('sends every digest with a six-hour TTL', async () => {
    const { db, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }]);
    await seedSubscription(db, 'https://push.example/a');
    const send = okSend();

    await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(send.mock.calls[0]?.[2]).toEqual({ TTL: 21600 });
    await db.close();
  });

  it('says "vacancy" for a single new job', async () => {
    const { db, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }]);
    await seedSubscription(db, 'https://push.example/a');
    const send = okSend();

    await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    const body = JSON.parse(String(send.mock.calls[0]?.[1])) as { body: string };
    expect(body.body).toBe('1 new bank vacancy in South Africa');
    await db.close();
  });

  it('prunes exactly the subscription the push service reports gone', async () => {
    const { db, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }]);
    await seedSubscription(db, 'https://push.example/dead');
    await seedSubscription(db, 'https://push.example/live');
    const send = vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/dead')) throw pushError(410);
      return { statusCode: 201, body: '', headers: {} };
    });

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(await endpoints(db)).toEqual(['https://push.example/live']);
    expect(summary.sent).toBe(1);
    expect(summary.pruned).toBe(1);
    expect(summary.failed).toBe(0);
    expect(await readWatermark(db)).toBe(DAY2);
    await db.close();
  });

  it('keeps the row and counts the failure on a non-gone error', async () => {
    const { db, logs, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }]);
    await seedSubscription(db, 'https://push.example/flaky');
    const send = vi.fn(async () => {
      throw pushError(500);
    });

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(await endpoints(db)).toEqual(['https://push.example/flaky']);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.pruned).toBe(0);
    // The watermark still moves: a retry next run would spam everyone else.
    expect(await readWatermark(db)).toBe(DAY2);
    // The endpoint is a credential, so it never reaches the log.
    expect(logs.join('\n')).not.toContain('push.example/flaky');
    await db.close();
  });

  it('writes nothing and sends nothing on a dry run', async () => {
    const { db, logs, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }, { id: 'absa:R-2' }]);
    await seedSubscription(db, 'https://push.example/a');
    const send = okSend();

    const summary = await runPushNotify(db, {
      vapidPrivateKey: VAPID_PRIVATE_KEY,
      dryRun: true,
      send,
      log,
    });

    expect(send).not.toHaveBeenCalled();
    expect(await readWatermark(db)).toBe(DAY1);
    expect(await endpoints(db)).toEqual(['https://push.example/a']);
    expect(summary.newJobs).toBe(2);
    expect(summary.subscribers).toBe(1);
    expect(summary.sent).toBe(0);
    expect(summary.watermark).toBe(DAY1);
    expect(logs.join('\n')).toContain('would send');
    await db.close();
  });

  it('does not write the bootstrap watermark on a dry run', async () => {
    const { db, logs, log } = harness();
    await seedJobs(db, DAY1, [{ id: 'absa:R-1' }]);

    const summary = await runPushNotify(db, {
      vapidPrivateKey: VAPID_PRIVATE_KEY,
      dryRun: true,
      send: okSend(),
      log,
    });

    expect(await readWatermark(db)).toBeUndefined();
    expect(summary.watermark).toBeNull();
    expect(logs.join('\n')).toContain('would initialize watermark');
    await db.close();
  });

  it('counts only open SA jobs — international, closed and hidden are excluded', async () => {
    const { db, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [
      { id: 'absa:R-1' },
      { id: 'absa:R-2', country: 'SC' },
      { id: 'absa:R-3' },
      { id: 'absa:R-4' },
    ]);
    await db.run("UPDATE jobs SET status = 'closed' WHERE id = 'absa:R-3'");
    await db.run("UPDATE jobs SET status = 'hidden' WHERE id = 'absa:R-4'");
    await seedSubscription(db, 'https://push.example/a');
    const send = okSend();

    const summary = await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send, log });

    expect(summary.newJobs).toBe(1);
    const body = JSON.parse(String(send.mock.calls[0]?.[1])) as { body: string };
    expect(body.body).toBe('1 new bank vacancy in South Africa');
    await db.close();
  });

  it('never throws — a broken ledger comes back as a logged summary', async () => {
    const { db, logs, log } = harness();
    await db.exec('DROP TABLE push_state');

    const summary = await runPushNotify(db, {
      vapidPrivateKey: VAPID_PRIVATE_KEY,
      send: okSend(),
      log,
    });

    expect(summary.sent).toBe(0);
    expect(logs.join('\n')).toContain('push: ERROR');
    await db.close();
  });

  it('signs with the public key the browser subscribed against', async () => {
    const { db, log } = harness();
    await setWatermark(db, DAY1);
    await seedJobs(db, DAY2, [{ id: 'absa:R-1' }]);
    await seedSubscription(db, 'https://push.example/a');
    const setVapidDetails = vi.spyOn(webpush, 'setVapidDetails');

    await runPushNotify(db, { vapidPrivateKey: VAPID_PRIVATE_KEY, send: okSend(), log });

    expect(setVapidDetails).toHaveBeenCalledWith(
      'mailto:tebellonamo@gmail.com',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY,
    );
    setVapidDetails.mockRestore();
    await db.close();
  });
});
