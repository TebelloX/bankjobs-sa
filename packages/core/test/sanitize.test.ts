import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeExcerpt, sanitizeDescription } from '../src/index';

const ALLOWED_TAGS = new Set(['p', 'ul', 'ol', 'li', 'h3', 'h4', 'strong', 'em', 'br']);

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/absa/detail-1.json', import.meta.url), 'utf8'),
);
const rawAbsaHtml: string = fixture.jobPostingInfo.jobDescription;

describe('sanitizeDescription — real Absa fixture', () => {
  const { html, text } = sanitizeDescription(rawAbsaHtml);

  it('strips containers and dangerous tags', () => {
    expect(html).not.toMatch(/<div/i);
    expect(html).not.toMatch(/<span/i);
    expect(html).not.toMatch(/<section/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<a[\s>]/i);
  });

  it('emits no attributes (no "=" inside any tag)', () => {
    // '=' inside a tag would indicate an attribute survived.
    expect(html).not.toMatch(/<[^>]*=[^>]*>/);
  });

  it('only emits allowlisted tags', () => {
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
    for (const tag of tags) {
      expect(ALLOWED_TAGS.has(tag)).toBe(true);
    }
  });

  it('produces clean plain text', () => {
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toMatch(/ {2,}/);
    expect(text).toBe(text.trim());
    expect(text.length).toBeGreaterThan(100);
  });

  it('produces a sensibly-bounded excerpt', () => {
    const excerpt = makeExcerpt(text);
    expect(excerpt.length).toBeGreaterThanOrEqual(250);
    expect(excerpt.length).toBeLessThanOrEqual(401);
    expect(/[.!?]$|…$/.test(excerpt)).toBe(true);
  });
});

describe('sanitizeDescription — transforms and unwrapping', () => {
  const cases: Array<[string, string]> = [
    ['<b>bold</b>', '<strong>bold</strong>'],
    ['<i>ital</i>', '<em>ital</em>'],
    ['<h1>a</h1>', '<h3>a</h3>'],
    ['<h2>b</h2>', '<h3>b</h3>'],
    ['<h5>c</h5>', '<h4>c</h4>'],
    ['<h6>d</h6>', '<h4>d</h4>'],
  ];

  it.each(cases)('transforms %s -> %s', (input, expected) => {
    expect(sanitizeDescription(input).html).toBe(expected);
  });

  it('replaces <a> with its text content (no tag)', () => {
    const { html } = sanitizeDescription('<p>See <a href="http://x.com">our site</a> now</p>');
    expect(html).toBe('<p>See our site now</p>');
  });

  it('discards div/span/section but keeps their children', () => {
    const { html } = sanitizeDescription('<div><span>kept</span></div><section>also</section>');
    expect(html).toBe('keptalso');
  });

  it('strips script/style content entirely', () => {
    const { html, text } = sanitizeDescription(
      '<script>evil()</script><style>.x{}</style><p>ok</p>',
    );
    expect(html).toBe('<p>ok</p>');
    expect(text).toBe('ok');
  });
});

describe('sanitizeDescription — text extraction', () => {
  it('inserts spaces at block boundaries so words do not concatenate', () => {
    expect(sanitizeDescription('<p>one</p><p>two</p>').text).toBe('one two');
    expect(sanitizeDescription('<ul><li>a</li><li>b</li></ul>').text).toBe('a b');
  });

  it('treats <br> as a space', () => {
    expect(sanitizeDescription('<p>line1<br>line2</p>').text).toBe('line1 line2');
  });

  it('decodes entities in plain text', () => {
    expect(sanitizeDescription('<p>Rock &amp; Roll</p>').text).toBe('Rock & Roll');
  });
});

describe('makeExcerpt', () => {
  it('returns text unchanged when within max', () => {
    expect(makeExcerpt('Short enough.', { min: 1, max: 100 })).toBe('Short enough.');
  });

  it('prefers a sentence boundary between min and max', () => {
    const result = makeExcerpt('First sentence. Second sentence continues on and on.', {
      min: 5,
      max: 20,
    });
    expect(result).toBe('First sentence.');
    expect(result.endsWith('.')).toBe(true);
  });

  it('falls back to a word boundary with an ellipsis', () => {
    const result = makeExcerpt('abcdefghij klmnopqrst uvwxyz more words here', { min: 5, max: 20 });
    expect(result).toBe('abcdefghij…');
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('uses default bounds of 300..400', () => {
    const long = 'word '.repeat(200).trim(); // ~999 chars, no sentence punctuation
    const result = makeExcerpt(long);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(401);
  });
});
