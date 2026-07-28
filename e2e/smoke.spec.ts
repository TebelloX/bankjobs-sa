import { test, expect, type Page } from '@playwright/test';

test('homepage renders the hero and links to the ledger', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('bank vacancy in South Africa');
  // :visible — the "N added since your last visit" line links to the ledger too
  // and ships hidden, so it is first in the DOM on a first-ever visit.
  await expect(page.locator('a[href^="/vacancies"]:visible').first()).toBeVisible();
});

test('vacancies ledger lists jobs', async ({ page }) => {
  await page.goto('/vacancies/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('a[href^="/jobs/"]').first()).toBeVisible();
});

test('job detail page renders from a ledger row', async ({ page }) => {
  await page.goto('/vacancies/');
  await page.locator('a[href^="/jobs/"]').first().click();
  await expect(page.locator('h1.detail-title')).toBeVisible();
});

test('related jobs on a detail page link to other vacancies', async ({ page }) => {
  await page.goto('/vacancies/');
  await page.locator('a[href^="/jobs/"]').first().click();
  await expect(page.locator('h1.detail-title')).toBeVisible();

  const here = new URL(page.url()).pathname;
  const section = page.locator('section.related');

  // The section is omitted when a job has no related rows, so this stays
  // conditional — but when it IS there, every link must be a real, different
  // job page. Which job the ledger surfaces first depends on the snapshot.
  if ((await section.count()) > 0) {
    const hrefs = await section
      .locator('a')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/jobs\/[^/]+\/$/);
      expect(href).not.toBe(here);
    }
    await expect(section.locator('a').first()).toBeVisible();
  }
});

test('search page renders', async ({ page }) => {
  await page.goto('/search');
  await expect(page.locator('h1')).toHaveText('Search vacancies');
});

// ---- search filters --------------------------------------------------------
// These run in STATIC mode: the e2e build has no PUBLIC_SEARCH_MODE, so the
// island takes the snapshot-and-filter-locally path — exactly the fallback the
// deployed site falls back to. Which banks/categories/provinces exist depends
// on the snapshot, so every test derives its target from the DOM rather than
// pinning a brand, a category or a count.

/** The "N of M vacancies" line, once the snapshot has loaded. */
const LOADED = /^\d+ of \d+ vacancies/;

/** Second segment of a result row's "brand · category · location" byline. */
function segment(src: string | null, index: number): string {
  return (src ?? '').split('·')[index]?.trim() ?? '';
}

/** Value of the <option> whose visible label is `label`. */
async function optionValue(select: ReturnType<Page['locator']>, label: string): Promise<string> {
  return select.evaluate(
    (el, name) =>
      Array.from((el as HTMLSelectElement).options).find((o) => o.text.trim() === name)?.value ??
      '',
    label,
  );
}

test('picking a category narrows the ledger, reflects in the URL and survives a reload', async ({
  page,
}) => {
  await page.goto('/search');
  const count = page.locator('#results-count');
  await expect(count).toHaveText(LOADED);
  const before = Number((await count.textContent())!.match(/^(\d+)/)![1]);

  // Filter by the first row's own category so there is guaranteed to be a match.
  const categoryName = segment(await page.locator('#search-results .src').first().textContent(), 1);
  expect(categoryName).not.toBe('');
  const select = page.locator('#filter-category');
  const slug = await optionValue(select, categoryName);
  expect(slug).not.toBe('');

  await select.selectOption(slug);
  await expect(count).toHaveText(LOADED);

  const rows = page.locator('#search-results .src');
  await expect(rows.first()).toBeVisible();
  const after = Number((await count.textContent())!.match(/^(\d+)/)![1]);
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
  for (const src of await rows.allTextContents()) {
    expect(segment(src, 1)).toBe(categoryName);
  }

  // URL carries the SLUG, not the canonical value.
  expect(new URL(page.url()).searchParams.get('category')).toBe(slug);

  // A shared/reloaded link prefills the select and lands on the same result set.
  await page.reload();
  await expect(count).toHaveText(LOADED);
  await expect(select).toHaveValue(slug);
  expect(Number((await count.textContent())!.match(/^(\d+)/)![1])).toBe(after);
  for (const src of await rows.allTextContents()) {
    expect(segment(src, 1)).toBe(categoryName);
  }
});

test('picking a bank filters to that brand', async ({ page }) => {
  await page.goto('/search');
  const count = page.locator('#results-count');
  await expect(count).toHaveText(LOADED);

  // Same trick as the category test — the first row's own brand always matches.
  const brand = segment(await page.locator('#search-results .src').first().textContent(), 0);
  expect(brand).not.toBe('');
  const select = page.locator('#filter-bank');
  const slug = await optionValue(select, brand);
  expect(slug).not.toBe('');

  await select.selectOption(slug);
  await expect(count).toHaveText(LOADED);

  const rows = page.locator('#search-results .src');
  await expect(rows.first()).toBeVisible();
  for (const src of await rows.allTextContents()) {
    expect(segment(src, 0)).toBe(brand);
  }
  expect(new URL(page.url()).searchParams.get('brand')).toBe(slug);
});

test('selecting a province locks the international toggle until it is cleared', async ({
  page,
}) => {
  await page.goto('/search');
  const count = page.locator('#results-count');
  await expect(count).toHaveText(LOADED);

  const intl = page.locator('#include-intl');
  const note = page.locator('#intl-note');
  await expect(intl).toBeEnabled();
  await expect(note).toBeHidden();

  // First real option — index 0 is "any province".
  const select = page.locator('#filter-province');
  const province = (await select.locator('option').nth(1).getAttribute('value'))!;
  expect(province).not.toBe('');

  await select.selectOption(province);
  await expect(intl).toBeDisabled();
  await expect(note).toBeVisible();
  await expect(intl).toHaveAttribute('aria-describedby', 'intl-note');
  expect(new URL(page.url()).searchParams.get('province')).toBe(province);

  await select.selectOption('');
  await expect(intl).toBeEnabled();
  await expect(note).toBeHidden();
  expect(new URL(page.url()).searchParams.has('province')).toBe(false);
});

// ---- saved vacancies -------------------------------------------------------
// The shortlist is localStorage-only (site/src/lib/savedJobs.ts). Playwright
// gives every test its own browser context, so each one starts with empty
// storage — no clean-up needed between them.

const SAVED_KEY = 'mybankjobs.saved.v1';

test('saving a vacancy lists it on /saved, and removing it empties the list', async ({ page }) => {
  await page.goto('/vacancies/');
  await page.locator('a[href^="/jobs/"]').first().click();
  const jobUrl = new URL(page.url()).pathname;
  const title = ((await page.locator('h1.detail-title').textContent()) ?? '').trim();
  expect(title).not.toBe('');

  // The button ships hidden and is revealed only where a storage write actually
  // round-trips — Chromium, so it must be here.
  const toggle = page.locator('[data-save-toggle]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText('save this vacancy');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  await expect(toggle).toHaveText(/saved/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Revisiting the page reflects the stored state rather than resetting.
  await page.reload();
  await expect(page.locator('[data-save-toggle]')).toHaveText(/saved/);

  await page.goto('/saved/');
  const rows = page.locator('#saved-list .job-row');
  await expect(rows).toHaveCount(1);
  const link = rows.first().locator('a.job-title');
  await expect(link).toHaveText(title);
  await expect(page.locator('#saved-count')).toContainText('1 saved vacancy');
  await expect(rows.first().locator('.row-note')).toHaveCount(0);

  // The link is a real, working job page.
  await expect(link).toHaveAttribute('href', jobUrl);
  await link.click();
  await expect(page.locator('h1.detail-title')).toHaveText(title);

  await page.goto('/saved/');
  await page.locator('#saved-list .row-remove').first().click();
  await expect(page.locator('#saved-list .job-row')).toHaveCount(0);
  await expect(page.locator('#saved-empty')).toBeVisible();
  await expect(page.locator('#saved-count')).toHaveText('no saved vacancies');
});

test('the footer saved link only appears once a vacancy is saved', async ({ page }) => {
  // Fresh context, nothing saved yet: the link ships hidden and stays that way.
  await page.goto('/');
  const footerSaved = page.locator('.ft-saved');
  await expect(footerSaved).toBeHidden();

  await page.goto('/vacancies/');
  await page.locator('a[href^="/jobs/"]').first().click();
  await page.locator('[data-save-toggle]').click();
  await expect(page.locator('[data-save-toggle]')).toHaveText(/saved/);

  // The footer script re-runs fresh on every page load.
  await page.goto('/');
  await expect(footerSaved).toBeVisible();

  await page.goto('/saved/');
  await page.locator('#saved-list .row-remove').first().click();
  await expect(page.locator('#saved-list .job-row')).toHaveCount(0);

  await page.goto('/');
  await expect(footerSaved).toBeHidden();
});

test('a saved vacancy that is no longer listed is flagged and not linked', async ({ page }) => {
  // A job id that cannot be in the snapshot: the saved page marks any entry the
  // published /data/jobs.json does not carry, because its /jobs/ page is gone.
  await page.addInitScript(
    ([key, entry]) => {
      window.localStorage.setItem(key as string, JSON.stringify([entry]));
    },
    [
      SAVED_KEY,
      {
        id: 'absa:definitely-closed-0000',
        slug: 'absa-definitely-closed-0000',
        title: 'Closed Vacancy — Branch Consultant',
        brand: 'Absa',
        category: 'Branch & Retail',
        primaryLocation: 'Sandton, Gauteng',
        postedDate: '2026-01-05',
        savedAt: '2026-07-01T09:00:00.000Z',
      },
    ],
  );

  await page.goto('/saved/');
  const row = page.locator('#saved-list .job-row').first();
  await expect(row).toContainText('Closed Vacancy — Branch Consultant');
  // The staleness pass runs after the snapshot fetch lands; both assertions
  // retry until it has.
  await expect(row.locator('.row-note')).toContainText('no longer listed');
  await expect(row.locator('a[href^="/jobs/"]')).toHaveCount(0);
  await expect(page.locator('#saved-count')).toContainText('1 no longer listed');

  // The row is still removable.
  await row.locator('.row-remove').click();
  await expect(page.locator('#saved-list .job-row')).toHaveCount(0);
});

test('every page footer links to the saved list', async ({ page }) => {
  // The footer link only renders for a visitor with a shortlist — seed one
  // entry so it is there to click.
  await page.addInitScript(
    ([key, entry]) => {
      window.localStorage.setItem(key as string, JSON.stringify([entry]));
    },
    [
      SAVED_KEY,
      {
        id: 'absa:footer-link-test-0000',
        slug: 'absa-footer-link-test-0000',
        title: 'Footer Link Test Vacancy',
        brand: 'Absa',
        category: 'Branch & Retail',
        primaryLocation: 'Sandton, Gauteng',
        postedDate: '2026-01-05',
        savedAt: '2026-07-01T09:00:00.000Z',
      },
    ],
  );

  await page.goto('/');
  await page.locator('.site-footer a[href="/saved/"]').click();
  await expect(page.locator('h1')).toHaveText('Saved vacancies');
});

test('province landing page renders a ledger with the right heading', async ({ page }) => {
  // Gauteng always has open roles in the snapshot, so its page is generated.
  await page.goto('/vacancies/gauteng/');
  await expect(page.locator('h1')).toContainText('Bank vacancies in Gauteng');
  await expect(page.locator('.joblist a[href^="/jobs/"]').first()).toBeVisible();
});

test('city landing page renders from the ledger "by city" row', async ({ page }) => {
  // Which cities clear the job floor depends on the snapshot, so this walks the
  // link row rather than naming a city — the row itself is what has to work.
  await page.goto('/vacancies/');
  const row = page.locator('p.quick', { hasText: 'By city:' });
  await row.locator('a[href^="/vacancies/"]').first().click();
  await expect(page.locator('h1')).toHaveText(/^Bank vacancies in .+ \(\d+\)$/);
  await expect(page.locator('.joblist a[href^="/jobs/"]').first()).toBeVisible();
});

test('category × province combo page renders from a province cross-link', async ({ page }) => {
  await page.goto('/vacancies/gauteng/');
  // The "by category" cross-links point at the combo pages for this province.
  await page.locator('.crosslinks a[href^="/browse/"][href$="/gauteng/"]').first().click();
  await expect(page.locator('h1')).toContainText('bank vacancies in Gauteng');
  await expect(page.locator('a[href^="/jobs/"]').first()).toBeVisible();
});

test('bank landing page renders from the homepage coverage ledger', async ({ page }) => {
  await page.goto('/');
  // The coverage ledger rows are the only /banks/ links on the homepage; which
  // brand is first depends on the snapshot, so stay off specific banks.
  await page.locator('a[href^="/banks/"]').first().click();
  await expect(page.locator('h1')).toContainText('vacancies');
  await expect(page.locator('.crosslinks a[href^="/banks/"]').first()).toBeVisible();
});

test('graduate & learnership hub renders a ledger or an honest empty state', async ({ page }) => {
  await page.goto('/browse/graduate-programmes/');
  await expect(page.locator('h1')).toContainText('Graduate programmes & learnerships');

  // This hub is the one page generated even at zero matches — bank intakes are
  // annual, so the ledger legitimately empties between cycles. Assert one state
  // or the other rather than pinning rows the next fetch could remove.
  const rows = page.locator('.joblist a[href^="/jobs/"]');
  if ((await rows.count()) > 0) {
    await expect(rows.first()).toBeVisible();
  } else {
    await expect(page.locator('.list-empty')).toBeVisible();
  }

  // The category cross-links are unconditional, so they hold in both states.
  await expect(page.locator('.crosslinks a[href^="/browse/"]').first()).toBeVisible();
});

test('entry-level hub renders a ledger or an honest empty state', async ({ page }) => {
  await page.goto('/browse/entry-level/');
  await expect(page.locator('h1')).toContainText('Entry-level bank jobs');

  // Generated even at zero matches, same as the graduate hub: frontline hiring
  // arrives in waves, so the ledger legitimately empties. Assert one state or
  // the other rather than pinning rows the next fetch could remove.
  const rows = page.locator('.joblist a[href^="/jobs/"]');
  if ((await rows.count()) > 0) {
    await expect(rows.first()).toBeVisible();
  } else {
    await expect(page.locator('.list-empty')).toBeVisible();
  }

  // The category cross-links are unconditional, so they hold in both states.
  await expect(page.locator('.crosslinks a[href^="/browse/"]').first()).toBeVisible();
});

test('homepage popular row links to the graduate hub', async ({ page }) => {
  await page.goto('/');
  await page.locator('.quick a[href^="/browse/graduate-programmes"]').click();
  await expect(page.locator('h1')).toContainText('Graduate programmes & learnerships');
});

test('homepage popular row links to the entry-level hub', async ({ page }) => {
  await page.goto('/');
  await page.locator('.quick a[href="/browse/entry-level/"]').first().click();
  await expect(page.locator('h1')).toContainText('Entry-level bank jobs');
});

test('numeric vacancies pagination still resolves alongside the province routes', async ({
  page,
}) => {
  const response = await page.goto('/vacancies/2/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('Open vacancies in South Africa');
  await expect(page.locator('a[href^="/jobs/"]').first()).toBeVisible();
});

// ---- insights ---------------------------------------------------------------
// Snapshot-agnostic: which bank leads the bar list and how many days the record
// holds both change with every fetch, so these assert the page's structure — the
// opening-balance row and a working bar link — rather than any figure.

test('insights page renders the statement, opening balance first', async ({ page }) => {
  await page.goto('/insights/');
  await expect(page.locator('h1')).toHaveText('Bank hiring, in figures');

  // Tracking began mid-life, so day one is an opening balance, never a day's
  // hiring — that first row is the honesty this page turns on.
  const rows = page.locator('table.ins-statement').first().locator('tbody tr');
  await expect(rows.first()).toContainText('Opening balance');
});

test('an insights bar row links through to a bank ledger', async ({ page }) => {
  await page.goto('/insights/');
  await page.locator('.ins-row a[href^="/banks/"]').first().click();
  await expect(page.locator('h1')).toContainText('vacancies');
});

test('homepage coverage ledger links to the insights page', async ({ page }) => {
  await page.goto('/');
  await page.locator('a[href="/insights/"]', { hasText: 'figures behind the statement' }).click();
  await expect(page.locator('h1')).toHaveText('Bank hiring, in figures');
});

// ---- new since your last visit ---------------------------------------------
// Visit bookkeeping is localStorage-only (site/src/lib/visit.ts) and every test
// gets its own browser context, so the first load in this test IS the
// first-ever visit — the state in which nothing may be flagged.

const VISIT_KEY = 'mybankjobs.visit.v1';

test('a returning visit flags new rows and totals them on the homepage', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.joblist .job-row').first()).toBeVisible();

  // Nothing to be new since: no flag and no count line on a first visit.
  await expect(page.locator('.new-flag:visible')).toHaveCount(0);
  await expect(page.locator('.visit-note')).toBeHidden();

  // Come back from a "previous session" older than the record itself. Every
  // row's firstSeen postdates the day tracking began, so this holds whatever
  // the snapshot carries — no date is pinned to a particular fetch.
  await page.evaluate(
    ([key, prev]) => {
      window.localStorage.setItem(key!, JSON.stringify({ prev, last: new Date().toISOString() }));
    },
    [VISIT_KEY, '2026-01-01T00:00:00.000Z'],
  );
  await page.reload();

  const flags = page.locator('.joblist .new-flag:visible');
  await expect(flags.first()).toBeVisible();
  await expect(flags.first()).toHaveText('new');

  // The count line is totalled from the per-day block baked into the page, and
  // the opening day is excluded from it — a snapshot whose whole post-opening
  // record is quiet (a fixtures build, or the first day of tracking) has
  // nothing to count, and saying nothing is the correct behaviour there.
  const baked = await page.evaluate(() => {
    const raw = document.getElementById('added-by-day')?.textContent ?? '{}';
    return Object.values(JSON.parse(raw) as Record<string, number>).reduce((n, v) => n + v, 0);
  });
  const note = page.locator('.visit-note');
  if (baked > 0) {
    await expect(note).toBeVisible();
    await expect(note).toHaveText(/^\d+ added since your last visit/);
    await expect(note.locator('a')).toHaveAttribute('href', '/vacancies/');
  } else {
    await expect(note).toBeHidden();
  }
});

// ---- find your fit ----------------------------------------------------------
// The matcher is browser-only (site/src/lib/matchFit.ts) over two same-origin
// snapshots, so these stay snapshot-agnostic the way the search tests are: a
// fixtures build can legitimately leave every scored bucket empty (tiny, odd
// job set), so they assert structure and accounting, never counts. Postgraduate
// is the probe profile because it clears every stated bar — no role can land in
// the counted-but-unlisted "above" tail, so the whole pool is on the page.

/** The bucket accounting line, once a qualification has been chosen. */
const FIT_LOADED = /^\d+ strong · \d+ possible · \d+ stretch fits out of \d+ open vacancies$/;

test('fit page keeps its privacy promise visible and asks for a qualification first', async ({
  page,
}) => {
  await page.goto('/fit/');
  await expect(page.locator('h1')).toContainText('Which roles fit your qualification');

  // The privacy line is the page's contract, rendered server-side — it is on
  // the page before the visitor has answered anything.
  await expect(
    page.locator('p.muted', { hasText: 'nothing you type leaves this page' }),
  ).toBeVisible();

  // Once the snapshots land the island has nothing to reckon yet: the status
  // line hides and the prompt shows. (During the fetch the status line reads
  // "Loading vacancies…" — both assertions retry into the loaded state.)
  await expect(page.locator('#fit-empty')).toBeVisible();
  await expect(page.locator('#fit-count')).toBeHidden();
});

test('choosing a qualification reckons the buckets and writes a shareable URL', async ({
  page,
}) => {
  await page.goto('/fit/');
  // The prompt is the signal that the island is live and listeners are wired.
  await expect(page.locator('#fit-empty')).toBeVisible();

  await page.locator('#fit-qual').selectOption('postgrad');
  await expect(page.locator('#fit-count')).toHaveText(FIT_LOADED);

  // Postgraduate means no role can sit more than one level out of reach.
  await expect(page.locator('#fit-above')).toBeHidden();

  // For this profile every pooled row lands in a VISIBLE bucket — scored, or
  // the honest couldn't-read one — so some row renders whatever the snapshot.
  await expect(page.locator('[data-fit-list] a.job-title').first()).toBeVisible();

  // An empty bucket hides its whole section; a shown one carries real job links.
  for (const section of await page.locator('[data-fit-section]').all()) {
    if (!(await section.isVisible())) continue;
    const hrefs = await section
      .locator('a.job-title')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/jobs\/[^/]+\/$/);
    }
  }

  expect(new URL(page.url()).searchParams.get('qual')).toBe('postgrad');
});

test('fit answers are remembered on this device and a bare revisit restores them', async ({
  page,
}) => {
  await page.goto('/fit/');
  await expect(page.locator('#fit-empty')).toBeVisible();

  await page.locator('#fit-qual').selectOption('degree');
  const count = page.locator('#fit-count');
  await expect(count).toHaveText(FIT_LOADED);
  const line = (await count.textContent())!;

  // A bare revisit — no parameters — rebuilds the same profile from
  // mybankjobs.match.v1 and lands on the identical reckoning.
  await page.goto('/fit/');
  await expect(page.locator('#fit-qual')).toHaveValue('degree');
  await expect(count).toHaveText(line);
});

// ---- push notifications -----------------------------------------------------
// The homepage toggle needs BOTH a browser that can do push and a build that
// carries a Worker origin to register the subscription with. Chromium has the
// APIs, but this e2e build is the plain `pnpm build` (see playwright.config.ts)
// — no PUBLIC_API_BASE — so the second gate fails and the block must stay
// hidden. That is the assertion below: in a PRODUCTION build
// (PUBLIC_SEARCH_MODE=api PUBLIC_API_BASE=…) the same script reveals it, which
// is verified by hand against the live API rather than here, because a real
// subscribe writes a real row to the production database.

test('the homepage push control ships hidden when the build has no API to register with', async ({
  page,
}) => {
  await page.goto('/');
  const push = page.locator('[data-push]');
  await expect(push).toHaveCount(1);
  await expect(push).toBeHidden();
  // Present in the markup, just never revealed — the same ships-hidden idiom as
  // the share and save buttons.
  await expect(page.locator('[data-push-toggle]')).toHaveCount(1);
});

test('the service worker is served and carries push handlers only', async ({ request }) => {
  const response = await request.get('/sw.js');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('javascript');

  const body = await response.text();
  expect(body).toContain('push');
  expect(body).toContain('notificationclick');
  // A fetch handler here would let a cached response outlive a rebuild and show
  // closed vacancies on a page still claiming to be fresh. Asserted on the
  // registration line rather than the word 'fetch', which the file's own
  // comments are free to use.
  expect(body).not.toContain("addEventListener('fetch'");
  expect(body).not.toContain('addEventListener("fetch"');
});

test('the site-wide rss feed is served as xml', async ({ request }) => {
  const response = await request.get('/feeds/all.xml');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('xml');
  expect(await response.text()).toContain('<rss');
});

test('unknown URL shows the 404 page', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-real-page');
  expect(response?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('Page not found');
});
