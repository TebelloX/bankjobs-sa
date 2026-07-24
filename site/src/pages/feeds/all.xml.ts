import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { saJobs } from '../../lib/data';
import { ALL_FEED, requireSite, toFeedItems } from '../../lib/feeds';

// The site-wide feed: the 50 newest South African vacancies across every bank.
// This is the one every page advertises in <head>, so it mirrors the homepage —
// South Africa only, newest first. (International roles have their own hub page
// but no feed; the per-bank feeds carry them for anyone who wants them.)
//
// `site` is also what @astrojs/rss emits as the channel <link>, so it points at
// the HTML page this feed mirrors. Item links are built absolute already, so
// nothing else resolves against it.
export const GET: APIRoute = (context) => {
  const site = requireSite(context.site);
  return rss({
    title: ALL_FEED.title,
    description:
      "Open vacancies at South Africa's banks, straight from the banks' own career systems. Free, no ads, updated a few times a day.",
    site: new URL('/', site),
    items: toFeedItems(saJobs(), site),
  });
};
