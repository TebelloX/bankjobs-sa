// Web-push subscription writes — the only non-GET surface on this API. Input is
// whatever a browser's PushSubscription.toJSON() produced, POSTed from a page we
// don't control the origin check on (CORS is open), so every field is validated
// hard and nothing else about the subscriber is stored.
import { CORS_HEADERS, errorJson, json } from './http';
import type { Env } from './types';

// A PushSubscription JSON is ~250 bytes; 4 KiB is generous. The body is read
// THROUGH the cap so an oversized POST is never buffered whole.
const MAX_BODY_BYTES = 4096;
const MAX_ENDPOINT_LEN = 1024;

// Both keys arrive base64url, unpadded (so no '=', '+' or '/'). p256dh is an
// uncompressed P-256 point — 65 bytes → 87 chars; auth is 16 random bytes → 22
// chars. The ranges allow for encoder quirks while still rejecting junk.
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const P256DH_MIN = 80;
const P256DH_MAX = 100;
const AUTH_MIN = 16;
const AUTH_MAX = 64;

/**
 * Read the body as text, giving up (null) the moment it passes `max` bytes.
 * `request.text()` would buffer the whole thing first, which is exactly what the
 * cap exists to prevent.
 */
async function readCappedText(request: Request, max: number): Promise<string | null> {
  const stream = request.body;
  if (stream === null) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; res: Response };

async function readJsonBody(request: Request): Promise<BodyResult> {
  const text = await readCappedText(request, MAX_BODY_BYTES);
  if (text === null) return { ok: false, res: errorJson(400, 'body too large') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, res: errorJson(400, 'invalid json') };
  }
  // Arrays and null are typeof 'object' — neither is a subscription.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: errorJson(400, 'invalid body') };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * The endpoint is a push-service URL we later POST to from the sender, so it must
 * be an absolute https: URL with no embedded credentials (a `user:pass@` form
 * would leak into the sender's request) and bounded in length.
 */
function isValidEndpoint(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ENDPOINT_LEN) return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}

function isValidKey(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max && BASE64URL.test(v);
}

/**
 * CORS preflight for /api/push/*. Free by design — no token, no D1: the browser
 * sends one before every POST and it touches nothing.
 */
export function pushPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** POST /api/push/subscribe — body: PushSubscription.toJSON(). */
export async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.res;

  const endpoint = body.value['endpoint'];
  if (!isValidEndpoint(endpoint)) return errorJson(400, 'invalid endpoint');

  const keys = body.value['keys'];
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
    return errorJson(400, 'missing keys');
  }
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (!isValidKey(p256dh, P256DH_MIN, P256DH_MAX)) return errorJson(400, 'invalid p256dh');
  if (!isValidKey(auth, AUTH_MIN, AUTH_MAX)) return errorJson(400, 'invalid auth');

  // Writes go to the binding directly — reader()'s 'first-unconstrained' session
  // is a read path. A re-subscribe refreshes the keys the browser rotated;
  // created_at deliberately keeps the original row's value.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(endpoint, p256dh, auth, new Date().toISOString())
    .run();

  return json({ ok: true }, 201);
}

/** POST /api/push/unsubscribe — body: `{ endpoint }`. */
export async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.res;

  const endpoint = body.value['endpoint'];
  if (!isValidEndpoint(endpoint)) return errorJson(400, 'invalid endpoint');

  // Idempotent: 200 whether or not a row existed. The caller only needs to know
  // the endpoint is gone, and a browser that unsubscribes twice isn't an error.
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  return json({ ok: true });
}
