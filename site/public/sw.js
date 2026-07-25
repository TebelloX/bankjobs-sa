// mybankjobs service worker — PUSH ONLY, and it must stay that way.
//
// THERE IS NO fetch HANDLER HERE ON PURPOSE, and adding one would be a
// regression, not a feature. A caching worker serves whatever it cached last:
// the ledger is rebuilt three times a day, jobs close and come down, and the
// "last updated" line at the top of every page is the promise the whole site is
// built on. A worker quietly answering from a stale cache would show a visitor
// vacancies that no longer exist while the page still claimed to be fresh —
// exactly the recruiter-repost behaviour this site exists to avoid. Freshness is
// left entirely to the network and Cloudflare's edge cache, which the ingest
// invalidates. If offline support is ever wanted, it needs a design that cannot
// outlive a rebuild, not an addEventListener here.
//
// Plain JavaScript, no imports, no build step: site/public/* is copied into
// dist/ VERBATIM by Astro (it is not bundled and not type-checked), so this file
// is served exactly as written. It sits at the root, which is what gives it the
// default '/' scope the page registers it with — no versioned filename, because
// a renamed worker would orphan every existing subscription.

// One digest per ingest run, at most three a day, and only when new South
// African roles actually landed. Payload is {title, body, url} JSON — but a push
// service can wake this worker with an empty or malformed body, and
// userVisibleOnly means a notification MUST be shown either way, so every field
// falls back to something honest rather than throwing.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = (event.data && event.data.json()) || {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'mybankjobs';
  const body =
    typeof payload.body === 'string' && payload.body ? payload.body : 'New bank vacancies';
  const url = typeof payload.url === 'string' && payload.url ? payload.url : '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Read back by the click handler below — the notification itself is the
      // only place this URL is stored.
      data: { url },
      icon: '/apple-touch-icon.png',
    }),
  );
});

// Tapping the digest opens the page it points at, reusing a tab that is already
// on the site rather than piling up windows.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const raw = typeof data.url === 'string' && data.url ? data.url : '/';
  // Resolved against our OWN origin: the payload is ours, but a relative '/…'
  // needs an origin to compare tabs against, and an absolute URL from anywhere
  // else must never be opened by a tap on our notification.
  let target;
  try {
    target = new URL(raw, self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  const href = target.href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        // navigate() is not implemented everywhere; focusing the existing tab is
        // the part that must not fail.
        if (typeof client.navigate === 'function') {
          return client
            .navigate(href)
            .then((navigated) => (navigated || client).focus())
            .catch(() => client.focus());
        }
        return client.focus();
      }
      return self.clients.openWindow(href);
    }),
  );
});
