import { describe, expect, it, vi } from 'vitest';
import { openD1Db } from '../src/d1http';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database/dbid/query';

/** Minimal `Response` stand-in exercising only the surface d1http reads. */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: new Headers(opts.headers),
    json: async () => opts.json,
  } as unknown as Response;
}

/** A successful single-statement D1 batch response. */
function d1Ok(results: Record<string, unknown>[], meta: Record<string, unknown> = {}): Response {
  return fakeResponse({
    json: { success: true, errors: [], result: [{ results, meta, success: true }] },
  });
}

function makeDb(fetchImpl: unknown): ReturnType<typeof openD1Db> {
  return openD1Db({
    accountId: 'acc',
    databaseId: 'dbid',
    apiToken: 'tok',
    fetchImpl: fetchImpl as typeof fetch,
    retryDelayMs: 1,
  });
}

describe('openD1Db', () => {
  it('POSTs to the D1 query endpoint with the auth header and JSON body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => d1Ok([{ id: 'x' }]));
    const db = makeDb(fetchImpl);

    await db.all('SELECT * FROM jobs WHERE source = ?', ['absa']);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      sql: 'SELECT * FROM jobs WHERE source = ?',
      params: ['absa'],
    });
  });

  it('omits params from the body when none are given', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => d1Ok([]));
    const db = makeDb(fetchImpl);

    await db.exec('DELETE FROM jobs');

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body).toEqual({ sql: 'DELETE FROM jobs' });
    expect('params' in body).toBe(false);
  });

  it('maps all to the result rows and get to the first row', async () => {
    const rows = [{ id: '1' }, { id: '2' }];
    const db = makeDb(vi.fn(async () => d1Ok(rows)));

    expect(await db.all('SELECT id FROM jobs')).toEqual(rows);
    expect(await db.get('SELECT id FROM jobs')).toEqual({ id: '1' });
  });

  it('returns undefined from get when there are no rows', async () => {
    const db = makeDb(vi.fn(async () => d1Ok([])));
    expect(await db.get('SELECT id FROM jobs WHERE id = ?', ['nope'])).toBeUndefined();
  });

  it('maps run to changes and lastInsertRowid from meta', async () => {
    const db = makeDb(vi.fn(async () => d1Ok([], { changes: 3, last_row_id: 42 })));
    expect(await db.run('INSERT INTO jobs VALUES (?)', ['x'])).toEqual({
      changes: 3,
      lastInsertRowid: 42,
    });
  });

  it('defaults run changes to 0 and lastInsertRowid to null when meta omits them', async () => {
    const db = makeDb(vi.fn(async () => d1Ok([], {})));
    expect(await db.run('UPDATE jobs SET status = ?', ['open'])).toEqual({
      changes: 0,
      lastInsertRowid: null,
    });
  });

  it('throws including the D1 error code and message on success:false', async () => {
    const db = makeDb(
      vi.fn(async () =>
        fakeResponse({
          json: {
            success: false,
            errors: [{ code: 7500, message: 'no such table: jobs' }],
            result: [],
          },
        }),
      ),
    );

    await expect(db.all('SELECT * FROM jobs')).rejects.toThrow('7500');
    await expect(db.all('SELECT * FROM jobs')).rejects.toThrow('no such table: jobs');
  });

  it('retries after a 429 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 429 }))
      .mockResolvedValueOnce(d1Ok([{ id: 'recovered' }]));
    const db = makeDb(fetchImpl);

    expect(await db.get('SELECT id FROM jobs')).toEqual({ id: 'recovered' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 up to four total attempts then throws', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 500 }));
    const db = makeDb(fetchImpl);

    await expect(db.run('INSERT INTO jobs VALUES (?)', ['x'])).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 400 }));
    const db = makeDb(fetchImpl);

    await expect(db.all('SELECT bad sql')).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a network rejection and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(d1Ok([{ id: 'ok' }]));
    const db = makeDb(fetchImpl);

    expect(await db.get('SELECT id FROM jobs')).toEqual({ id: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('runs a transaction fn exactly once with no HTTP call of its own', async () => {
    const fetchImpl = vi.fn(async () => d1Ok([]));
    const db = makeDb(fetchImpl);
    const fn = vi.fn(async () => 'result');

    expect(await db.transaction(fn)).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
