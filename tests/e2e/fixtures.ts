/**
 * Shared Playwright helpers — specification section 41.
 *
 * These specs run against a live `netlify dev` with a seeded database and
 * ZOHO_MOCK_MODE=true. See the README section "Running the end-to-end tests".
 */

import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'StockRecheck!2026';

export const USERS = {
  administrator: { email: 'admin@example.com', name: 'Asha Menon' },
  counterOne: { email: 'counter1@example.com', name: 'Ravi Kumar' },
  counterTwo: { email: 'counter2@example.com', name: 'Priya Nair' },
} as const;

export async function signIn(
  page: Page,
  user: { email: string },
  password = DEMO_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/app\/dashboard/);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Opens the first active Stock Recheck from the dashboard. */
export async function openFirstRecheck(page: Page): Promise<string> {
  await page.goto('/app/rechecks');
  const open = page.getByRole('link', { name: 'Open' }).first();
  await open.click();
  await expect(page).toHaveURL(/\/app\/rechecks\/[^/]+\/workspace/);

  const match = /\/app\/rechecks\/([^/]+)\/workspace/.exec(page.url());
  return match?.[1] ?? '';
}

/** Claims the first available item and lands on its counting screen. */
export async function claimFirstAvailableItem(page: Page): Promise<{ sku: string }> {
  await page.getByLabel('Status').selectOption('available');
  await expect(page.getByRole('button', { name: 'Claim Item' }).first()).toBeVisible();

  // Capture the SKU before claiming so the scan can use it.
  const row = page.locator('tbody tr').first();
  const sku = (await row.locator('td').nth(2).innerText()).trim();

  await page.getByRole('button', { name: 'Claim Item' }).first().click();
  await expect(page).toHaveURL(/\/items\/[^/]+\/count/);

  return { sku };
}

/** Sends a scan the way a hardware scanner does: text then Enter. */
export async function scan(page: Page, value: string): Promise<void> {
  const input = page.getByLabel('Scan SKU');
  await input.fill(value);
  await input.press('Enter');
}

export async function readCount(page: Page): Promise<number> {
  const text = await page.locator('text=Counted Quantity').locator('..').innerText();
  const match = /(\d+)/.exec(text.replace('Counted Quantity', ''));
  return Number.parseInt(match?.[1] ?? '0', 10);
}
