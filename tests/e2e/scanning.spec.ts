/**
 * End-to-end scenarios 5-9 — specification section 41.
 *
 * Good scan, wrong-item scan, unknown scan, local-count recovery and zero
 * count. These are the behaviours an operator hits hundreds of times a day.
 */

import { expect, test } from '@playwright/test';
import { claimFirstAvailableItem, openFirstRecheck, scan, signIn, USERS } from './fixtures';

test.describe('counting and scanning', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, USERS.counterOne);
    await openFirstRecheck(page);
  });

  /* ------------------------------------------------ Scenario 5: good scan */
  test('a valid scan increments the count, clears the field and keeps focus', async ({ page }) => {
    const { sku } = await claimFirstAvailableItem(page);

    await expect(page.getByText('Counted Quantity')).toBeVisible();
    await expect(page.locator('.tabular.text-6xl')).toHaveText('0');

    await scan(page, sku);

    // Count 0 → 1.
    await expect(page.locator('.tabular.text-6xl')).toHaveText('1');
    // Input cleared.
    await expect(page.getByLabel('Scan SKU')).toHaveValue('');
    // Focus retained for the next scan.
    await expect(page.getByLabel('Scan SKU')).toBeFocused();

    // A second scan of the same SKU increments again.
    await scan(page, sku);
    await expect(page.locator('.tabular.text-6xl')).toHaveText('2');
  });

  test('accepts a scan with the trailing carriage return a scanner appends', async ({ page }) => {
    const { sku } = await claimFirstAvailableItem(page);

    const input = page.getByLabel('Scan SKU');
    await input.fill(`${sku}\r`);
    await input.press('Enter');

    await expect(page.locator('.tabular.text-6xl')).toHaveText('1');
  });

  /* ------------------------------- Scenario 6: scan belonging to another item */
  test('a scan for another item does not increment and keeps the bad value', async ({ page }) => {
    await claimFirstAvailableItem(page);

    // A SKU that exists in the recheck but is not the claimed item.
    const otherSku = 'XYZ-002';
    await scan(page, otherSku);

    // Count unchanged.
    await expect(page.locator('.tabular.text-6xl')).toHaveText('0');
    // Field NOT cleared.
    await expect(page.getByLabel('Scan SKU')).toHaveValue(otherSku);
    // Error names the other item.
    await expect(page.getByRole('alert')).toContainText('This scan belongs to');
    await expect(page.getByRole('alert')).toContainText(otherSku);
    // Focus stays in the scanner.
    await expect(page.getByLabel('Scan SKU')).toBeFocused();
  });

  /* --------------------------------------------- Scenario 7: unknown scan */
  test('an unknown scan does not increment and is not cleared', async ({ page }) => {
    await claimFirstAvailableItem(page);

    await scan(page, 'TOTALLY-UNKNOWN-CODE');

    await expect(page.locator('.tabular.text-6xl')).toHaveText('0');
    await expect(page.getByLabel('Scan SKU')).toHaveValue('TOTALLY-UNKNOWN-CODE');
    await expect(page.getByRole('alert')).toContainText('SKU not found in this Stock Recheck.');
  });

  test('an empty Enter press is ignored entirely', async ({ page }) => {
    await claimFirstAvailableItem(page);

    await page.getByLabel('Scan SKU').press('Enter');

    await expect(page.locator('.tabular.text-6xl')).toHaveText('0');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  /* --------------------------------------- Scenario 8: local count recovery */
  test('a local count survives a page refresh', async ({ page }) => {
    const { sku } = await claimFirstAvailableItem(page);

    for (let index = 0; index < 5; index += 1) await scan(page, sku);
    await expect(page.locator('.tabular.text-6xl')).toHaveText('5');

    await page.reload();

    // The claim is still ours and the claim version is unchanged, so the draft
    // is restored (section 22).
    await expect(page.locator('.tabular.text-6xl')).toHaveText('5');
  });

  test('Undo Last Scan reduces the count by exactly one', async ({ page }) => {
    const { sku } = await claimFirstAvailableItem(page);

    await scan(page, sku);
    await scan(page, sku);
    await expect(page.locator('.tabular.text-6xl')).toHaveText('2');

    await page.getByRole('button', { name: 'Undo Last Scan' }).click();
    await expect(page.locator('.tabular.text-6xl')).toHaveText('1');
  });

  /* ------------------------------------------------ Scenario 9: zero count */
  test('a counted quantity of zero can be submitted and is called out', async ({ page }) => {
    await claimFirstAvailableItem(page);

    await page.getByRole('button', { name: 'Submit Results' }).click();

    // The dialog must state the zero explicitly.
    await expect(page.getByRole('dialog')).toContainText('You are submitting a counted quantity of 0.');

    await page.getByLabel('I confirm that I have finished counting this item.').check();
    await page.getByRole('button', { name: 'Submit Final Count' }).click();

    await expect(page).toHaveURL(/\/items\/[^/]+\/submitted/);
    await expect(page.getByText('Counted')).toBeVisible();
  });

  test('submission cannot proceed without the confirmation checkbox', async ({ page }) => {
    await claimFirstAvailableItem(page);
    await page.getByRole('button', { name: 'Submit Results' }).click();

    await expect(page.getByRole('button', { name: 'Submit Final Count' })).toBeDisabled();
  });
});
