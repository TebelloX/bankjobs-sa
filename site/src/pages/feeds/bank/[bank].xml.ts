import rss from '@astrojs/rss';
import type { APIRoute, GetStaticPaths } from 'astro';
import { BRANDS } from '@bankjobs/core';
import type { Brand } from '@bankjobs/core';
import { allOpenJobs } from '../../../lib/data';
import { BANK_SLUGS } from '../../../lib/banks';
import { bankFeed, requireSite, toFeedItems } from '../../../lib/feeds';

// One feed per bank, on exactly the same predicate as /banks/[bank]/: the brand
// has at least one OPEN job in ANY country. Feed existence has to track page
// existence — the page is where the feed is advertised, and a feed URL that
// 404s is worse than one that is quiet, because readers drop the subscription.
export const getStaticPaths = (() => {
  const open = allOpenJobs();
  return BRANDS.filter((name) => open.some((j) => j.brand === name)).map((name) => ({
    params: { bank: BANK_SLUGS[name] },
    props: { brand: name },
  }));
}) satisfies GetStaticPaths;

// CONTENT DECISION: the /banks/ page lists South African roles only, but this
// feed carries the brand's open roles in EVERY country. Someone who subscribes
// to "Absa jobs" wants Absa's jobs; splitting them across an SA feed and an
// international feed would hide half of them behind a URL nobody links to.
// Ordering stays newest-first (SA and international interleave by date) — the
// SA roles are the bulk of every brand's ledger, and a reader sorts by pubDate
// anyway, so a country-first sort would only fight the reader's own ordering.
export const GET: APIRoute<{ brand: Brand }> = (context) => {
  const site = requireSite(context.site);
  const { brand } = context.props;
  const jobs = allOpenJobs().filter((j) => j.brand === brand);

  return rss({
    title: bankFeed(brand, BANK_SLUGS[brand]).title,
    description: `Open roles at ${brand}, straight from ${brand}'s own career system — South Africa and international. Updated a few times a day.`,
    site: new URL(`/banks/${BANK_SLUGS[brand]}/`, site),
    items: toFeedItems(jobs, site),
  });
};
