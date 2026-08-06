import { describe, expect, it, vi } from 'vitest';
import { ensureIngestRun, RECENT_RUN_WINDOW_MS } from '../src/watchdog';

const NOW = new Date('2026-08-07T02:20:00Z');

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

function runsResponse(createdAts: string[]): Response {
  return new Response(
    JSON.stringify({ workflow_runs: createdAts.map((created_at) => ({ created_at })) }),
    { status: 200 },
  );
}

function fetchReturning(...responses: Response[]) {
  const impl = vi.fn<typeof fetch>();
  for (const res of responses) impl.mockResolvedValueOnce(res);
  return impl;
}

describe('ensureIngestRun', () => {
  it('does nothing when a run was created inside the window', async () => {
    const fetchImpl = fetchReturning(runsResponse([minutesBefore(18)]));

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).resolves.toBe(
      'recent-run-exists',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.github.com/repos/TebelloX/bankjobs-sa/actions/workflows/ingest.yml/runs?per_page=10',
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer t');
    expect(headers['user-agent']).toBeTruthy();
  });

  it('dispatches when the newest run is older than the window', async () => {
    const fetchImpl = fetchReturning(
      runsResponse([minutesBefore(26), minutesBefore(60 * 7)]),
      new Response(null, { status: 204 }),
    );

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).resolves.toBe('dispatched');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe(
      'https://api.github.com/repos/TebelloX/bankjobs-sa/actions/workflows/ingest.yml/dispatches',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main' });
  });

  it('dispatches when the workflow has no runs at all', async () => {
    const fetchImpl = fetchReturning(runsResponse([]), new Response(null, { status: 204 }));

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).resolves.toBe('dispatched');
  });

  it('treats a run exactly at the window edge as recent', async () => {
    const fetchImpl = fetchReturning(
      runsResponse([new Date(NOW.getTime() - RECENT_RUN_WINDOW_MS).toISOString()]),
    );

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).resolves.toBe(
      'recent-run-exists',
    );
  });

  it('ignores runs with unparseable timestamps rather than counting them as recent', async () => {
    const fetchImpl = fetchReturning(
      runsResponse(['not-a-date']),
      new Response(null, { status: 204 }),
    );

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).resolves.toBe('dispatched');
  });

  it('throws when listing runs fails, without dispatching blind', async () => {
    const fetchImpl = fetchReturning(new Response('nope', { status: 401 }));

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).rejects.toThrow('HTTP 401');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when the dispatch is rejected', async () => {
    const fetchImpl = fetchReturning(runsResponse([]), new Response('missing', { status: 404 }));

    await expect(ensureIngestRun({ token: 't', now: NOW, fetchImpl })).rejects.toThrow('HTTP 404');
  });
});
