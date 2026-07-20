import { describe, expect, it } from 'vitest';
import { cleanApplyUrl } from '../src/index';

const cases: Array<[string, string, string]> = [
  [
    'strips utm_* params',
    'https://x.com/a?utm_source=g&utm_medium=m&keep=1',
    'https://x.com/a?keep=1',
  ],
  [
    'strips fbclid/gclid/source/src case-insensitively',
    'https://x.com/?fbclid=1&gclid=2&source=3&src=4&SRC=5&Source=6&real=7',
    'https://x.com/?real=7',
  ],
  [
    'leaves a clean url with a path unchanged',
    'https://absa.wd3.myworkdayjobs.com/ABSAcareersite/job/Lydenburg/Adviser_R-15987866',
    'https://absa.wd3.myworkdayjobs.com/ABSAcareersite/job/Lydenburg/Adviser_R-15987866',
  ],
  [
    'keeps non-tracking params',
    'https://x.com/search?q=analyst&page=2',
    'https://x.com/search?q=analyst&page=2',
  ],
];

describe('cleanApplyUrl', () => {
  it.each(cases)('%s', (_desc, input, expected) => {
    expect(cleanApplyUrl(input)).toBe(expected);
  });

  it('returns the raw input unchanged on parse failure', () => {
    expect(cleanApplyUrl('not a url')).toBe('not a url');
    expect(cleanApplyUrl('')).toBe('');
    expect(cleanApplyUrl('/relative/path')).toBe('/relative/path');
  });

  it('removes all tracking params but preserves the rest of the url', () => {
    const result = cleanApplyUrl('https://x.com/p?utm_campaign=a&fbclid=b');
    expect(result).toBe('https://x.com/p');
  });
});
