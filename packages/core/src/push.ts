// The applicationServerKey handed to PushManager.subscribe() AND the public half
// of the VAPID keypair the sender signs with — one value in both roles, so core
// holds it once and the site's client bundle and the ingest sender both import
// it rather than keeping their own copies (a mismatch would silently break every
// send).
//
// PUBLIC BY DESIGN: it ships in every client bundle. The private half lives only
// in the Actions secret VAPID_PRIVATE_KEY and the operator's
// ~/.config/bankjobs/vapid.json.
//
// Rotating the pair ORPHANS every stored subscription — a browser rejects a push
// signed by a key other than the one it subscribed with — so rotation means
// re-subscribing everyone, not a config swap.
export const VAPID_PUBLIC_KEY =
  'BM0VxTduxFUpmsyodxNAqolE26vf-ZcKPKGa7XycJceQ9BxxAroNCFG0dkYcOshzAH3xWWU-nyZJ48BxVqHOTE0';
