import { describe, expect, it } from 'vitest';
import {
  ALL_FEED,
  FEED_LIMIT,
  bankFeed,
  capForFeed,
  categoryFeed,
  requireSite,
  sortForFeed,
  toFeedItems,
} from '../src/lib/feeds';
import type { FeedJob } from '../src/lib/feeds';

const ORIGIN = 'https://mybankjobs.co.za';

function job(overrides: Partial<FeedJob> & Pick<FeedJob, 'id'>): FeedJob {
  return {
    slug: overrides.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title: 'Branch Consultant',
    brand: 'Absa',
    excerpt: 'A role at a bank.',
    postedDate: '2026-07-01',
    firstSeen: '2026-07-01T06:00:00.000Z',
    ...overrides,
  };
}

describe('sortForFeed', () => {
  it('orders by posted date, newest first', () => {
    const sorted = sortForFeed([
      job({ id: 'b', postedDate: '2026-07-10' }),
      job({ id: 'a', postedDate: '2026-07-20' }),
      job({ id: 'c', postedDate: '2026-07-15' }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(['a', 'c', 'b']);
  });

  it('falls back to the first-seen DAY when postedDate is null', () => {
    // 'b' has no posted date but was first seen on the 20th, so it outranks a
    // row posted on the 10th and trails one posted on the 25th.
    const sorted = sortForFeed([
      job({ id: 'a', postedDate: '2026-07-10' }),
      job({ id: 'b', postedDate: null, firstSeen: '2026-07-20T23:30:00.000Z' }),
      job({ id: 'c', postedDate: '2026-07-25' }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(['c', 'b', 'a']);
  });

  it('ignores the clock time inside firstSeen when ordering', () => {
    // Same day, different crawl times: the id tiebreak decides, not the hour —
    // otherwise a re-crawl could reshuffle the feed.
    const sorted = sortForFeed([
      job({ id: 'zzz', postedDate: null, firstSeen: '2026-07-20T23:59:00.000Z' }),
      job({ id: 'aaa', postedDate: null, firstSeen: '2026-07-20T00:01:00.000Z' }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(['aaa', 'zzz']);
  });

  it('breaks ties on id so the order is deterministic', () => {
    const rows = [job({ id: 'absa:3' }), job({ id: 'absa:1' }), job({ id: 'absa:2' })];
    expect(sortForFeed(rows).map((j) => j.id)).toEqual(['absa:1', 'absa:2', 'absa:3']);
    // Same set, different input order — same output.
    expect(sortForFeed([...rows].reverse()).map((j) => j.id)).toEqual([
      'absa:1',
      'absa:2',
      'absa:3',
    ]);
  });

  it('does not mutate the input array', () => {
    const rows = [job({ id: 'a', postedDate: '2026-07-01' }), job({ id: 'b', postedDate: null })];
    const before = rows.map((j) => j.id);
    sortForFeed(rows);
    expect(rows.map((j) => j.id)).toEqual(before);
  });
});

describe('capForFeed', () => {
  it('caps at 50 by default', () => {
    expect(FEED_LIMIT).toBe(50);
    const rows = Array.from({ length: 120 }, (_, i) => job({ id: `id-${i}` }));
    expect(capForFeed(rows)).toHaveLength(50);
  });

  it('leaves shorter lists alone', () => {
    expect(capForFeed([job({ id: 'a' }), job({ id: 'b' })])).toHaveLength(2);
    expect(capForFeed([])).toEqual([]);
  });
});

describe('toFeedItems', () => {
  it('keeps the 50 NEWEST, not the first 50 handed in', () => {
    // 120 rows, oldest first: the cap must apply after the sort.
    const rows = Array.from({ length: 120 }, (_, i) =>
      job({
        id: `id-${String(i).padStart(3, '0')}`,
        postedDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );
    const items = toFeedItems(rows, ORIGIN);
    expect(items).toHaveLength(50);
    const dates = items.map((i) => i.pubDate.getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(dates[0]).toBe(new Date('2026-01-28').getTime());
  });

  it('builds the item the way a reader shows it', () => {
    const [item] = toFeedItems(
      [
        job({
          id: 'absa:R-15989289',
          slug: 'absa-r-15989289',
          title: 'Corporate Actions Team Leader',
          brand: 'Absa',
          excerpt: 'Lead the Investor Services Operations function.',
          postedDate: '2026-07-21',
        }),
      ],
      ORIGIN,
    );
    expect(item).toEqual({
      title: 'Corporate Actions Team Leader — Absa',
      link: 'https://mybankjobs.co.za/jobs/absa-r-15989289/',
      pubDate: new Date('2026-07-21'),
      description: 'Lead the Investor Services Operations function.',
      customData: '<guid isPermaLink="false">absa:R-15989289</guid>',
    });
  });

  it('dates a row with no postedDate from its full firstSeen timestamp', () => {
    // Ordering uses the DAY, but the pubDate keeps the crawl time — the most
    // precise honest claim we can make about when the posting appeared.
    const [item] = toFeedItems(
      [job({ id: 'a', postedDate: null, firstSeen: '2026-07-21T08:22:24.487Z' })],
      ORIGIN,
    );
    expect(item?.pubDate.toISOString()).toBe('2026-07-21T08:22:24.487Z');
  });

  it('reads a date-only postedDate as UTC midnight, never localized', () => {
    const [item] = toFeedItems([job({ id: 'a', postedDate: '2026-07-21' })], ORIGIN);
    expect(item?.pubDate.toISOString()).toBe('2026-07-21T00:00:00.000Z');
    expect(item?.pubDate.toUTCString()).toBe('Tue, 21 Jul 2026 00:00:00 GMT');
  });

  it('XML-escapes the guid it writes by hand', () => {
    const [item] = toFeedItems([job({ id: 'weird:<&">\'x' })], ORIGIN);
    expect(item?.customData).toBe(
      '<guid isPermaLink="false">weird:&lt;&amp;&quot;&gt;&apos;x</guid>',
    );
    // The guid text carries no raw markup delimiters, and every '&' it does
    // carry opens an entity rather than sitting bare.
    const guidText = item?.customData.slice('<guid isPermaLink="false">'.length, -'</guid>'.length);
    expect(guidText).not.toMatch(/[<>"']/);
    expect(guidText).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
  });

  it('leaves titles and descriptions unescaped — @astrojs/rss does that', () => {
    const [item] = toFeedItems(
      [job({ id: 'a', title: 'Risk & Compliance <Lead>', excerpt: 'Bonds & "structured" credit' })],
      ORIGIN,
    );
    expect(item?.title).toBe('Risk & Compliance <Lead> — Absa');
    expect(item?.description).toBe('Bonds & "structured" credit');
  });

  it('makes every link absolute against the origin it is given', () => {
    const items = toFeedItems([job({ id: 'a', slug: 'fnb-123' })], new URL('https://example.test'));
    expect(items[0]?.link).toBe('https://example.test/jobs/fnb-123/');
  });

  it('returns nothing for an empty ledger', () => {
    expect(toFeedItems([], ORIGIN)).toEqual([]);
  });
});

describe('requireSite', () => {
  it('passes the configured site through', () => {
    const site = new URL('https://mybankjobs.co.za');
    expect(requireSite(site)).toBe(site);
  });

  it('fails loudly rather than emitting relative feed links', () => {
    expect(() => requireSite(undefined)).toThrow(/site/);
  });
});

describe('feed links', () => {
  it('advertises the site-wide feed at a stable URL', () => {
    expect(ALL_FEED).toEqual({ href: '/feeds/all.xml', title: 'mybankjobs — new vacancies' });
  });

  it('points at the endpoints the routes generate', () => {
    expect(bankFeed('Standard Bank', 'standard-bank')).toEqual({
      href: '/feeds/bank/standard-bank.xml',
      title: 'mybankjobs — new Standard Bank vacancies',
    });
    expect(categoryFeed('Software & IT', 'software-it')).toEqual({
      href: '/feeds/category/software-it.xml',
      title: 'mybankjobs — new Software & IT vacancies',
    });
  });
});
