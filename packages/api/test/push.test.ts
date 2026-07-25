import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimiter } from '../src/ratelimit';
import { call, callJson } from './helpers';
import { seedAll } from './seed';

// A real-shaped PushSubscription.toJSON(): 87-char p256dh (uncompressed P-256
// point), 22-char auth (16 random bytes), both base64url and unpadded.
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/cZq9x1TnE:APA91bH-subscription-token';
const P256DH =
  'BM0VxTduxFUpmsyodxNAqolE26vf-ZcKPKGa7XycJceQ9BxxAroNCFG0dkYcOshzAH3xWWU-nyZJ48BxVqHOTE0';
const AUTH = 'k8JV6sjdbhAi91mKYqoWfQ';

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

function subscription(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: ENDPOINT,
    expirationTime: null,
    keys: { p256dh: P256DH, auth: AUTH },
    ...over,
  };
}

/** POST a JSON body (or a raw string, for the malformed-JSON cases). */
function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return call(path, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(headers ? { headers } : {}),
  });
}

function readRow(endpoint: string): Promise<SubRow | null> {
  return env.DB.prepare(
    'SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE endpoint = ?',
  )
    .bind(endpoint)
    .first<SubRow>();
}

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('OPTIONS /api/push/* (preflight)', () => {
  it('answers 204 with the CORS preflight headers', async () => {
    const res = await call('/api/push/subscribe', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(await res.text()).toBe('');
  });

  it('preflight spends no rate-limit token', async () => {
    const headers = { 'CF-Connecting-IP': '20.20.20.20' };
    for (let i = 0; i < 40; i++) {
      const res = await call('/api/push/subscribe', { method: 'OPTIONS', headers });
      expect(res.status).toBe(204);
    }
  });
});

describe('POST /api/push/subscribe', () => {
  it('stores the subscription and returns 201 {ok:true}', async () => {
    const res = await post('/api/push/subscribe', subscription());
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ ok: true });

    const row = await readRow(ENDPOINT);
    expect(row).not.toBeNull();
    expect(row?.endpoint).toBe(ENDPOINT);
    expect(row?.p256dh).toBe(P256DH);
    expect(row?.auth).toBe(AUTH);
    // created_at is a server-side ISO timestamp, not client input.
    expect(Number.isNaN(Date.parse(row?.created_at ?? ''))).toBe(false);
  });

  it('is never cached (no Cache-Control / X-Cache) and repeats cleanly', async () => {
    const first = await post('/api/push/subscribe', subscription());
    expect(first.headers.get('X-Cache')).toBeNull();
    expect(first.headers.get('Cache-Control')).toBeNull();
    const second = await post('/api/push/subscribe', subscription());
    expect(second.status).toBe(201);
  });

  it('re-subscribing the same endpoint refreshes the keys but keeps created_at', async () => {
    const created = '2020-01-01T00:00:00.000Z';
    await env.DB.prepare(
      'INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?)',
    )
      .bind(ENDPOINT, `${P256DH.slice(0, 86)}Z`, 'OLDauthOLDauthOLDauth1', created)
      .run();

    const res = await post('/api/push/subscribe', subscription());
    expect(res.status).toBe(201);

    const row = await readRow(ENDPOINT);
    expect(row?.p256dh).toBe(P256DH);
    expect(row?.auth).toBe(AUTH);
    expect(row?.created_at).toBe(created);

    const counted = await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').first<{
      count: number;
    }>();
    expect(Number(counted?.count)).toBe(1); // upsert, not a second row
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('deletes the row and stays idempotent', async () => {
    await post('/api/push/subscribe', subscription());
    expect(await readRow(ENDPOINT)).not.toBeNull();

    const { res, body } = await callJson<{ ok: boolean }>('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: ENDPOINT }),
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(await readRow(ENDPOINT)).toBeNull();

    // Second call: no row, still 200 {ok:true}.
    const again = await post('/api/push/unsubscribe', { endpoint: ENDPOINT });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  it('rejects an endpoint that is not an https URL', async () => {
    const res = await post('/api/push/unsubscribe', { endpoint: 'http://push.example/x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });
});

describe('subscribe validation', () => {
  const cases: [name: string, body: unknown][] = [
    ['malformed JSON', '{"endpoint":'],
    ['empty body', ''],
    ['a JSON array', []],
    ['a JSON string', '"nope"'],
    ['no endpoint', { keys: { p256dh: P256DH, auth: AUTH } }],
    ['a non-string endpoint', subscription({ endpoint: 42 })],
    ['an http:// endpoint', subscription({ endpoint: 'http://fcm.googleapis.com/fcm/send/x' })],
    ['a relative endpoint', subscription({ endpoint: '/fcm/send/x' })],
    ['credentials in the endpoint', subscription({ endpoint: 'https://u:p@fcm.example/send/x' })],
    [
      'an over-long endpoint',
      subscription({ endpoint: `https://fcm.example/${'x'.repeat(1024)}` }),
    ],
    ['no keys at all', { endpoint: ENDPOINT }],
    ['null keys', subscription({ keys: null })],
    ['keys missing auth', subscription({ keys: { p256dh: P256DH } })],
    ['keys missing p256dh', subscription({ keys: { auth: AUTH } })],
    [
      'a non-base64url p256dh',
      subscription({ keys: { p256dh: `${P256DH.slice(0, 86)}+`, auth: AUTH } }),
    ],
    ['a padded auth', subscription({ keys: { p256dh: P256DH, auth: 'k8JV6sjdbhAi91mKYqoW==' } })],
    ['a short p256dh', subscription({ keys: { p256dh: 'BM0VxTdux', auth: AUTH } })],
    ['a long p256dh', subscription({ keys: { p256dh: P256DH.repeat(2), auth: AUTH } })],
    ['a short auth', subscription({ keys: { p256dh: P256DH, auth: 'abc' } })],
    ['a long auth', subscription({ keys: { p256dh: P256DH, auth: AUTH.repeat(4) } })],
  ];

  for (const [name, body] of cases) {
    it(`400s on ${name}`, async () => {
      const res = await post('/api/push/subscribe', body);
      expect(res.status).toBe(400);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
      expect(await readRow(ENDPOINT)).toBeNull(); // nothing written on rejection
    });
  }

  it('400s on a body over the 4096-byte cap', async () => {
    // Valid subscription, padded past the cap by an ignored field: the cap trips
    // before parsing, so this is rejected on size alone.
    const big = subscription({ pad: 'x'.repeat(5000) });
    const res = await post('/api/push/subscribe', big);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    expect(await readRow(ENDPOINT)).toBeNull();
  });

  it('accepts a body just under the cap', async () => {
    const res = await post('/api/push/subscribe', subscription({ pad: 'x'.repeat(3800) }));
    expect(res.status).toBe(201);
  });
});

describe('push routing', () => {
  it('405 JSON (Allow: POST, OPTIONS) for GET /api/push/subscribe', async () => {
    const res = await call('/api/push/subscribe');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it('405 for a non-POST, non-OPTIONS method', async () => {
    const res = await call('/api/push/unsubscribe', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('404 JSON for an unknown /api/push/ path', async () => {
    const res = await post('/api/push/nope', subscription());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it('leaves the read API 405 (Allow: GET) for POST /api/jobs', async () => {
    const res = await call('/api/jobs', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
  });

  it('trailing slashes normalize (POST /api/push/subscribe/)', async () => {
    const res = await post('/api/push/subscribe/', subscription());
    expect(res.status).toBe(201);
  });
});

describe('push rate limiting', () => {
  it('spends a token per POST and 429s once the burst is gone', async () => {
    const headers = { 'CF-Connecting-IP': '10.10.10.10' };
    let ok = 0;
    let limited = 0;
    let retryAfter: string | null = null;
    // Unique endpoint per request: nothing here is cacheable, so every POST pays.
    for (let i = 0; i < 26; i++) {
      const res = await post(
        '/api/push/subscribe',
        subscription({ endpoint: `https://fcm.googleapis.com/fcm/send/token-${i}` }),
        headers,
      );
      if (res.status === 429) {
        limited++;
        retryAfter = res.headers.get('Retry-After');
      } else {
        ok++;
      }
    }
    expect(ok).toBeLessThanOrEqual(20); // capacity
    expect(limited).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });
});
