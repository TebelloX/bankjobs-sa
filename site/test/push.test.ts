import { afterEach, describe, expect, it, vi } from 'vitest';
import { VAPID_PUBLIC_KEY as CORE_VAPID_PUBLIC_KEY } from '@bankjobs/core';
import { VAPID_PUBLIC_KEY, pushSupported, urlBase64ToUint8Array } from '../src/lib/push';

// Only the pure pieces are covered here. subscribe()/unsubscribe()/
// getSubscription() are thin wrappers over ServiceWorkerContainer, PushManager
// and Notification — faking all three well enough to prove anything would be
// testing the fake, so those paths are covered by the browser pass instead.

it('the site copy of the VAPID public key still matches core', () => {
  // lib/push.ts copies the constant rather than importing core's barrel, which
  // would drag ~10KB of unrelated core modules into the homepage bundle. This is
  // the guard that makes the copy safe: a browser rejects a push signed with any
  // key other than the one it subscribed with, so drift here would break every
  // delivery silently, with nothing failing anywhere else.
  expect(VAPID_PUBLIC_KEY).toBe(CORE_VAPID_PUBLIC_KEY);
});

describe('urlBase64ToUint8Array', () => {
  it('decodes the real VAPID key to an uncompressed P-256 point', () => {
    // The one input this is actually called with in the browser. A P-256 public
    // key is 65 bytes and always starts with 0x04 (the uncompressed-point tag) —
    // if the padding or the URL-safe substitutions were wrong, neither would
    // hold.
    const bytes = urlBase64ToUint8Array(CORE_VAPID_PUBLIC_KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it('puts back the padding base64url leaves off', () => {
    // 'aGVsbG8' is 7 chars — atob refuses it until one '=' is restored.
    expect([...urlBase64ToUint8Array('aGVsbG8')]).toEqual([...Buffer.from('hello')]);
    // 'aGk' is 3 chars: two '=' to restore.
    expect([...urlBase64ToUint8Array('aGk')]).toEqual([...Buffer.from('hi')]);
    // A length already divisible by 4 must not gain a stray '='.
    expect([...urlBase64ToUint8Array('aGVsbA')]).toEqual([...Buffer.from('hell')]);
  });

  it("maps the URL-safe alphabet back to '+' and '/'", () => {
    // 0x3effbf encodes as 'Pv+/' in standard base64 — the only three bytes
    // needed to exercise both substituted characters at once.
    expect([...urlBase64ToUint8Array('Pv-_')]).toEqual([0x3e, 0xff, 0xbf]);
  });

  it('round-trips arbitrary bytes through the base64url form', () => {
    const original = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    const base64url = Buffer.from(original).toString('base64url');
    expect([...urlBase64ToUint8Array(base64url)]).toEqual([...original]);
  });

  it('decodes an empty string to no bytes', () => {
    expect(urlBase64ToUint8Array('').length).toBe(0);
  });
});

describe('pushSupported', () => {
  // The module reaches for the globals at CALL time and guards their absence, so
  // node can stand in for every combination — including the shapes that matter:
  // no service worker at all, and iOS Safari's "service worker but no
  // PushManager outside a home-screen app".
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false in a plain node environment (no window)', () => {
    expect(pushSupported()).toBe(false);
  });

  it('is true only when all three APIs are present', () => {
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
    expect(pushSupported()).toBe(true);
  });

  it('is false without a service worker', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
    expect(pushSupported()).toBe(false);
  });

  it('is false without PushManager (a browser tab on iOS Safari)', () => {
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('window', { Notification: class {} });
    expect(pushSupported()).toBe(false);
  });

  it('is false without Notification', () => {
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('window', { PushManager: class {} });
    expect(pushSupported()).toBe(false);
  });
});
