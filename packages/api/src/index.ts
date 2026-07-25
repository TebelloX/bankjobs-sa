import { CACHE_CONTROL, cacheKey } from './cache';
import { handleJobDetail, handleJobsList, handleMeta } from './handlers';
import { errorJson } from './http';
import { handlePushSubscribe, handlePushUnsubscribe, pushPreflight } from './push';
import { takeToken } from './ratelimit';
import type { Env } from './types';

const JOBS_PREFIX = '/api/jobs/';
const PUSH_PREFIX = '/api/push/';

function normalizePath(url: URL): string {
  return url.pathname.replace(/\/+$/, '') || '/';
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url);

  if (path === '/api/jobs') return handleJobsList(url, env);
  if (path.startsWith(JOBS_PREFIX)) {
    const id = decodeURIComponent(path.slice(JOBS_PREFIX.length));
    if (id === '') return errorJson(404, 'not found');
    return handleJobDetail(id, env);
  }
  if (path === '/api/meta') return handleMeta(env);
  return errorJson(404, 'not found');
}

/**
 * /api/push/* — the only writes. Routed entirely around the cache (caches.default
 * is GET-only, and a subscription write must never be served from a cache), so
 * these spend a rate-limit token up front instead of after a cache miss.
 */
async function routePush(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return pushPreflight();
  if (request.method !== 'POST') {
    return errorJson(405, 'method not allowed', { Allow: 'POST, OPTIONS' });
  }

  const gate = takeToken(clientIp(request));
  if (!gate.allowed) {
    return errorJson(429, 'rate limit exceeded', { 'Retry-After': String(gate.retryAfter) });
  }

  if (path === '/api/push/subscribe') return handlePushSubscribe(request, env);
  if (path === '/api/push/unsubscribe') return handlePushUnsubscribe(request, env);
  return errorJson(404, 'not found');
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const path = normalizePath(new URL(request.url));
    if (path.startsWith(PUSH_PREFIX)) return routePush(request, env, path);

    if (request.method !== 'GET') {
      return errorJson(405, 'method not allowed', { Allow: 'GET' });
    }

    const key = cacheKey(request, env.VERSION?.id);
    const cache = caches.default;

    // Cache HIT is served BEFORE the limiter spends a token — cached traffic is
    // exactly what we want to keep free and unthrottled.
    const hit = await cache.match(key);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('X-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    const gate = takeToken(clientIp(request));
    if (!gate.allowed) {
      // 429s are never cached.
      return errorJson(429, 'rate limit exceeded', { 'Retry-After': String(gate.retryAfter) });
    }

    const response = await route(request, env);
    if (response.status !== 200) return response;

    // Store (and return) a copy carrying the cache directives + MISS marker.
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', CACHE_CONTROL);
    headers.set('X-Cache', 'MISS');
    const out = new Response(response.body, { status: 200, headers });
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
} satisfies ExportedHandler<Env>;
