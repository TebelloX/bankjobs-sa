import { test, expect } from '@playwright/test';

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

test('numeric vacancies pagination still resolves alongside the province routes', async ({
  page,
}) => {
  const response = await page.goto('/vacancies/2/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('Open vacancies in South Africa');
  await expect(page.locator('a[href^="/jobs/"]').first()).toBeVisible();
});

test('unknown URL shows the 404 page', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-real-page');
  expect(response?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('Page not found');
});
