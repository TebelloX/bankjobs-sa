import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

const ORIGIN = 'https://api.bankjobs.test';

// The handler types its first arg as an incoming request (CF props); a plain
// `new Request` is structurally identical for our purposes.
type IncomingRequest = Parameters<typeof worker.fetch>[0];

/** Drive the Worker's fetch handler and flush waitUntil (so cache.put lands). */
export async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, init) as unknown as IncomingRequest;
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function callJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; body: T }> {
  const res = await call(path, init);
  return { res, body: (await res.json()) as T };
}

export interface JobRow {
  id: string;
  slug: string;
  title: string;
  brand: string;
  source: string;
  category: string;
  categorySlug: string;
  city: string | null;
  province: string | null;
  primaryLocation: string | null;
  country: string;
  excerpt: string;
  postedDate: string | null;
  applyUrl: string;
}

export interface ListResp {
  total: number;
  limit: number;
  offset: number;
  jobs: JobRow[];
}

export function ids(list: ListResp): string[] {
  return list.jobs.map((j) => j.id);
}
