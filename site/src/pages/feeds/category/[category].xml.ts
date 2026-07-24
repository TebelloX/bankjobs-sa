import rss from '@astrojs/rss';
import type { APIRoute, GetStaticPaths } from 'astro';
import { CATEGORY_SLUGS } from '@bankjobs/core';
import type { Category } from '@bankjobs/core';
import { saJobs } from '../../../lib/data';
import { categoryFeed, requireSite, toFeedItems } from '../../../lib/feeds';

// One feed per category, ALWAYS all ten — unlike the bank feeds, these are
// generated even when the category has no open roles. The ten /browse/ pages
// are always generated too, so the advertised URL always resolves, and an empty
// feed is the correct answer for a subscriber waiting on the first vacancy in a
// quiet category. A 404 would make their reader unsubscribe instead.
export const getStaticPaths = (() =>
  (Object.entries(CATEGORY_SLUGS) as Array<[Category, string]>).map(([name, slug]) => ({
    params: { category: slug },
    props: { name, slug },
  }))) satisfies GetStaticPaths;

// South Africa only, matching what the /browse/ page lists.
export const GET: APIRoute<{ name: Category; slug: string }> = (context) => {
  const site = requireSite(context.site);
  const { name, slug } = context.props;
  const jobs = saJobs().filter((j) => j.categorySlug === slug);

  return rss({
    title: categoryFeed(name, slug).title,
    description: `Open ${name} vacancies at South African banks — official listings, updated a few times a day.`,
    site: new URL(`/browse/${slug}/`, site),
    items: toFeedItems(jobs, site),
  });
};
