import { test, expect, type Page } from '@playwright/test';

test('homepage renders the hero and links to the ledger', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('bank vacancy in South Africa');
  await expect(page.locator('a[href^="/vacancies"]').first()).toBeVisible();
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

test('homepage popular row links to the graduate hub', async ({ page }) => {
  await page.goto('/');
  await page.locator('.quick a[href^="/browse/graduate-programmes"]').click();
  await expect(page.locator('h1')).toContainText('Graduate programmes & learnerships');
});

test('numeric vacancies pagination still resolves alongside the province routes', async ({
  page,
}) => {
  const response = await page.goto('/vacancies/2/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('Open vacancies in South Africa');
  await expect(page.locator('a[href^="/jobs/"]').first()).toBeVisible();
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
