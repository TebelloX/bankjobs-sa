import { describe, expect, it } from 'vitest';

import { describeError } from '../src/index';

// Mirror the failure shape that motivated the helper: undici wraps every
// network-level failure as `TypeError: fetch failed` with the actionable
// error (ConnectTimeoutError, ENOTFOUND, …) in `cause`, itself possibly an
// AggregateError with one error per attempted address.
function undiciStyleError(): TypeError {
  const connectTimeout = Object.assign(new Error('Connect Timeout Error'), {
    name: 'ConnectTimeoutError',
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  return new TypeError('fetch failed', { cause: connectTimeout });
}

describe('describeError', () => {
  it('renders a bare error as its message alone', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('renders a non-Error value via String()', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError(42)).toBe('42');
  });

  it('surfaces the undici cause with name and code', () => {
    expect(describeError(undiciStyleError())).toBe(
      'fetch failed — caused by ConnectTimeoutError: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)',
    );
  });

  it('walks a multi-level cause chain', () => {
    const inner = new Error('socket hang up');
    const mid = new Error('request to upstream failed', { cause: inner });
    const outer = new Error('ingest failed', { cause: mid });
    expect(describeError(outer)).toBe(
      'ingest failed — caused by Error: request to upstream failed — caused by Error: socket hang up',
    );
  });

  it('caps a cyclic cause chain instead of looping', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    const rendered = describeError(a);
    // Depth-capped: finite output that still shows the alternation.
    expect(rendered.startsWith('a — caused by Error: b — caused by Error: a')).toBe(true);
    expect(rendered.length).toBeLessThan(200);
  });

  it('renders a non-Error cause via String()', () => {
    const err = new Error('outer', { cause: 'raw cause' });
    expect(describeError(err)).toBe('outer — caused by raw cause');
  });

  it('expands an AggregateError cause into its sub-errors', () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connect ENETUNREACH ::1:443'), { code: 'ENETUNREACH' }),
      ],
      '',
    );
    const err = new TypeError('fetch failed', { cause: agg });
    expect(describeError(err)).toBe(
      'fetch failed — caused by AggregateError:  ' +
        '[Error: connect ETIMEDOUT 1.2.3.4:443 (ETIMEDOUT); ' +
        'Error: connect ENETUNREACH ::1:443 (ENETUNREACH)]',
    );
  });

  it('truncates an AggregateError with many sub-errors', () => {
    const agg = new AggregateError(
      [1, 2, 3, 4, 5].map((n) => new Error(`fail ${n}`)),
      'all failed',
    );
    expect(describeError(agg)).toBe(
      'all failed [Error: fail 1; Error: fail 2; Error: fail 3; +2 more]',
    );
  });
});
