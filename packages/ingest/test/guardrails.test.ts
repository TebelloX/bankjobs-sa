import { describe, expect, it } from 'vitest';
import { checkAnomaly } from '../src/guardrails';

describe('checkAnomaly', () => {
  it('trips on zero jobs with no baseline', () => {
    expect(checkAnomaly(0, null)).toEqual({ ok: false, reason: 'source returned zero jobs' });
  });

  it('trips on zero jobs even with a baseline', () => {
    expect(checkAnomaly(0, 78)).toEqual({ ok: false, reason: 'source returned zero jobs' });
  });

  it('trips when the count drops to under half of the last success', () => {
    expect(checkAnomaly(30, 78)).toEqual({
      ok: false,
      reason: 'count dropped >50%: 30 vs 78',
    });
  });

  it('does not trip exactly at the 50% boundary', () => {
    expect(checkAnomaly(39, 78)).toEqual({ ok: true });
  });

  it('is baseline-exempt on the first run (only the zero check applies)', () => {
    expect(checkAnomaly(3, null)).toEqual({ ok: true });
  });

  it('passes a healthy count against a baseline', () => {
    expect(checkAnomaly(78, 78)).toEqual({ ok: true });
    expect(checkAnomaly(80, 78)).toEqual({ ok: true });
  });
});
