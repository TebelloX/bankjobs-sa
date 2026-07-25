// Web-push opt-in — the one thing on this site that leaves the browser.
//
// Everything else the visitor does here is local: the shortlist and the visit
// clock are localStorage keys that are never sent anywhere (see savedJobs.ts and
// visit.ts). Notifications cannot be, so this module is deliberately the ONLY
// exception, and it keeps the exception as small as it can be: what the server
// stores is the browser's own push endpoint plus the two encryption keys that
// come with it — an anonymous delivery address, no name, no email, no id we
// chose. Turning notifications off deletes the row. That bargain is spelled out
// on /about; if this module ever sends more, that page has to change with it.
//
// Kept dependency-free ON PURPOSE and IMPORTLESS, exactly like visit.ts and
// savedJobs.ts: it is imported by the homepage's client script, so it must never
// import lib/data.ts or lib/insights.ts (both pull a gitignored job snapshot
// into whatever bundle reaches them). That is also why VAPID_PUBLIC_KEY is
// copied below instead of imported from @bankjobs/core — see the constant.
//
// The API base is a PARAMETER on every network call, so node tests never need a
// real one and the module has no build-time coupling to the Worker.

/**
 * The applicationServerKey PushManager.subscribe() is given — the public half of
 * the VAPID pair the ingest's sender signs every digest with. Public by design:
 * it ships in the client bundle.
 *
 * COPIED from packages/core/src/push.ts, which is the source of truth, rather
 * than imported: core has no subpath export for it, and importing the barrel
 * drags core's other modules into this bundle. Measured — the homepage script
 * went 589 → 11,281 bytes on `import { VAPID_PUBLIC_KEY } from '@bankjobs/core'`
 * (rollup keeps the barrel's side-effectful modules even when the constant is
 * all that is referenced). A copy is a drift risk, so site/test/push.test.ts
 * asserts the two are identical: if they ever diverge, `pnpm test` fails rather
 * than every notification silently failing to be delivered.
 */
export const VAPID_PUBLIC_KEY =
  'BM0VxTduxFUpmsyodxNAqolE26vf-ZcKPKGa7XycJceQ9BxxAroNCFG0dkYcOshzAH3xWWU-nyZJ48BxVqHOTE0';

/**
 * Worker origin the subscription is registered with — the same build-time env
 * var searchClient.ts reads for search (precedent: PUBLIC_API_BASE there).
 * Read straight from import.meta.env rather than imported from searchClient,
 * because that module's config guard THROWS on an 'api' build with no base and
 * has no business running in this one's client bundle.
 *
 * Empty on a plain `pnpm build` (the static-search fallback, and every CI/e2e
 * build): there is nowhere to register a subscription then, so the homepage
 * leaves the whole control hidden rather than shipping a button that cannot
 * work.
 */
export const PUSH_API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? '';

/**
 * Root-scoped worker at site/public/sw.js. Push only — no fetch handler.
 *
 * Needs no CSP change: the site's policy (site/public/_headers) sets neither
 * worker-src nor child-src, and worker-src falls back through child-src to
 * `script-src 'self'`, which allows this same-origin script. The two POSTs below
 * go to an origin connect-src already lists for search.
 */
const SW_URL = '/sw.js';

/** Explicit and version-free: a renamed worker would orphan every subscription. */
const SW_SCOPE = '/';

/** What a subscribe attempt actually achieved, in the visitor's terms. */
export type SubscribeResult =
  /** Stored server-side and confirmed — the browser will get digests. */
  | 'subscribed'
  /** The visitor (or a browser-level block) refused the permission prompt. */
  | 'denied'
  /** Everything else: registration failed, the POST failed, the API said no. */
  | 'failed';

/**
 * Whether this browser can do web push at all.
 *
 * All three checks matter: iOS Safari has service workers but only exposes
 * PushManager to installed home-screen apps, and a browser with notifications
 * disabled by policy can drop Notification entirely. Guarded against a missing
 * `window`/`navigator` so the module can be imported (and unit-tested) in node.
 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * base64url → bytes, for the applicationServerKey PushManager.subscribe wants.
 *
 * VAPID keys are published unpadded and URL-safe ('-'/'_' for '+'/'/'), which is
 * exactly what atob does NOT accept, so the padding and the two substitutions
 * both have to be put back before decoding. The result is the 65-byte
 * uncompressed P-256 point the push service checks the sender's signature
 * against.
 *
 * Typed Uint8Array<ArrayBuffer>, not a bare Uint8Array: since TypeScript 5.7 the
 * bare form widens to ArrayBufferLike (which admits SharedArrayBuffer) and would
 * not satisfy the BufferSource that applicationServerKey wants. Allocating the
 * buffer explicitly is what pins it — no cast, so the type stays honest.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * This browser's existing subscription, or null — the state the toggle paints
 * itself from on load.
 *
 * getRegistration(), NOT navigator.serviceWorker.ready: `ready` only settles
 * once a worker is ACTIVE, so on a visitor who has never opted in (the common
 * case) it would hang forever and the control would never paint. getRegistration
 * resolves with undefined instead, which is precisely the "not subscribed"
 * answer. Every failure degrades to null: a browser that cannot tell us is a
 * browser with no subscription as far as the label is concerned.
 */
export async function getSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!registration) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Register the worker, ask for permission, subscribe, and hand the subscription
 * to the API — in that order, so a worker that cannot even register never
 * produces a permission prompt.
 *
 * If the API does not accept the subscription, the browser-side one is UNDONE
 * before returning: leaving it in place would give this browser a live
 * subscription no server row backs, i.e. a toggle reading "notifications on"
 * that could never deliver anything. Better to fail visibly and let them retry.
 */
export async function subscribe(apiBase: string): Promise<SubscribeResult> {
  if (!pushSupported() || !apiBase) return 'failed';

  try {
    await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });

    const permission = await Notification.requestPermission();
    // 'default' too: dismissing the prompt without choosing is not consent, and
    // it must not be reported as anything but "no".
    if (permission !== 'granted') return 'denied';

    // `ready`, NOT the registration register() just returned: that one can still
    // be INSTALLING, and subscribing on a registration with no ACTIVE worker
    // fails outright — 'AbortError: Subscription failed - no active Service
    // Worker', which is exactly what a first opt-in hit before this line
    // existed. Safe here (unlike in getSubscription) precisely because
    // registration has already been asked for above, so `ready` will settle.
    const registration = await navigator.serviceWorker.ready;

    const subscription = await registration.pushManager.subscribe({
      // Required by every browser that implements push, and true in substance:
      // each send shows a notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const response = await fetch(`${apiBase}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) {
      await subscription.unsubscribe().catch(() => false);
      return 'failed';
    }
    return 'subscribed';
  } catch {
    return 'failed';
  }
}

/**
 * Turn notifications off: tell the API to drop the row, then unsubscribe the
 * browser.
 *
 * The POST is fire-and-forget — a failure is not reported and not retried. The
 * browser-side unsubscribe is what actually stops the digests, and the sender
 * already prunes rows whose push service reports them gone (404/410), so a
 * missed delete costs one wasted send, not a notification the visitor turned
 * off. Blocking the toggle on a network round-trip would be worse.
 */
export async function unsubscribe(apiBase: string): Promise<void> {
  const subscription = await getSubscription();
  if (!subscription) return;

  if (apiBase) {
    try {
      await fetch(`${apiBase}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
    } catch {
      // See above: the unsubscribe below is the part that matters.
    }
  }

  try {
    await subscription.unsubscribe();
  } catch {
    // Nothing left to do — the row is already gone server-side.
  }
}
