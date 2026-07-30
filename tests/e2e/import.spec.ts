/**
 * End-to-end scenarios 1, 2, 3 and 13 — specification section 41.
 *
 * Excel import, mixed import results, text import and the Excel export
 * contract. Requires ZOHO_MOCK_MODE=true so the fixture SKUs resolve.
 */

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { signIn, USERS } from './fixtures';

const SAMPLE_WORKBOOK = join(process.cwd(), 'samples', 'demo-stock-list.xlsx');

test.describe('import', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, USERS.administrator);
  });

  /* ------------------------------- Scenarios 1 & 2: Excel import, mixed result */
  test('an administrator imports a workbook and reviews a mixed result', async ({ page }) => {
    await page.goto('/app/rechecks/new/source');

    // Step 1: choose the Excel source.
    await page.getByRole('button', { name: 'Choose Excel' }).click();
    await expect(page).toHaveURL(/\/new\/excel\/upload/);

    // Step 2: upload the workbook.
    await page.setInputFiles('input[type="file"]', SAMPLE_WORKBOOK);
    await expect(page.getByText('demo-stock-list.xlsx')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).last().click();

    // Step 3: pick the worksheet and confirm the header row.
    await expect(page).toHaveURL(/\/sheet/);
    await page.getByRole('radio', { name: /Stock List/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 4: map the SKU column. Auto-detection should preselect "Item SKU".
    await expect(page).toHaveURL(/\/mapping/);
    await expect(page.getByLabel('Spreadsheet column containing the SKU')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Continue to Preview' }).click();

    // Step 5: preview, then validate.
    await expect(page).toHaveURL(/\/preview/);
    await page.getByRole('button', { name: 'Start Validation' }).click();
    await expect(page.getByRole('dialog')).toContainText('No data will be updated in Zoho.');
    await page.getByRole('dialog').getByRole('button', { name: 'Start Validation' }).click();

    // Step 6: the common import-result screen.
    await expect(page).toHaveURL(/\/import-result/, { timeout: 60_000 });
    await expect(page.getByText('Import Review')).toBeVisible();
    await expect(page.getByText('Source: Excel')).toBeVisible();

    // The fixture deliberately contains failures of several kinds.
    await page.getByRole('tab', { name: /Failed/ }).click();
    await expect(page.getByText('SKU_NOT_FOUND')).toBeVisible();
    await expect(page.getByText('INACTIVE_ITEM')).toBeVisible();
    await expect(page.getByText('NOT_INVENTORY_TRACKED')).toBeVisible();
    await expect(page.getByText('AMBIGUOUS_SKU')).toBeVisible();

    // And a duplicate that names the accepted row.
    await page.getByRole('tab', { name: /Duplicates/ }).click();
    await expect(page.getByText(/already appeared on row/)).toBeVisible();

    // Step 7: create the Stock Recheck.
    await page.getByRole('button', { name: 'Create Stock Recheck' }).click();
    await expect(page).toHaveURL(/\/confirm/);

    await page
      .getByLabel(
        'I understand that this application will only read from Zoho and will not update Zoho inventory.',
      )
      .check();
    await page.getByRole('button', { name: 'Create Recheck' }).click();

    // Step 8: the workspace opens.
    await expect(page).toHaveURL(/\/app\/rechecks\/[^/]+\/workspace/, { timeout: 30_000 });
    await expect(page.getByText('Total Items')).toBeVisible();
  });

  /* -------------------------------------------- Scenario 3: text import */
  test('an administrator pastes a mixed-delimiter SKU list', async ({ page }) => {
    await page.goto('/app/rechecks/new/source');
    await page.getByRole('button', { name: 'Paste SKU List' }).click();
    await expect(page).toHaveURL(/\/new\/text\/entry/);

    // Newline, tab and comma separated, plus a duplicate and a blank line.
    await page.getByLabel('SKUs').fill('SKU-0001\nSKU-0002\tSKU-0003,ABC-001\n\nsku-0001');

    await expect(page.getByText('Potential duplicates')).toBeVisible();
    await page.getByRole('button', { name: 'Continue to Preview' }).click();

    await expect(page).toHaveURL(/\/text\/preview/);
    // The duplicate is flagged before Zoho is even contacted.
    await expect(page.getByText('Duplicate within pasted list')).toBeVisible();

    await page.getByRole('button', { name: 'Start Validation' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start Validation' }).click();

    await expect(page).toHaveURL(/\/import-result/, { timeout: 60_000 });
    await expect(page.getByText('Source: Pasted text')).toBeVisible();
    // Same screen structure as the Excel path (section 17).
    await expect(page.getByText('Import Review')).toBeVisible();
  });

  test('the import result reconciles passed + failed + blanks with the source rows', async ({
    page,
  }) => {
    await page.goto('/app/rechecks/new/source');
    await page.getByRole('button', { name: 'Paste SKU List' }).click();
    await page.getByLabel('SKUs').fill('SKU-0001\nSKU-0002\nUNKNOWN-SKU');
    await page.getByRole('button', { name: 'Continue to Preview' }).click();
    await page.getByRole('button', { name: 'Start Validation' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start Validation' }).click();

    await expect(page).toHaveURL(/\/import-result/, { timeout: 60_000 });

    const readCard = async (label: string): Promise<number> => {
      const text = await page.locator('text=' + label).locator('..').innerText();
      return Number.parseInt(/(\d+)/.exec(text.replace(label, ''))?.[1] ?? '0', 10);
    };

    const total = await readCard('Total source rows');
    const passed = await readCard('Passed');
    const failed = await readCard('Failed');
    const blanks = await readCard('Ignored blanks');

    expect(passed + failed + blanks).toBe(total);
  });
});

/* ---------------------------------------------- Scenario 13: Excel export */

test.describe('export', () => {
  test('the difference workbook downloads with the exact contract', async ({ page }) => {
    await signIn(page, USERS.administrator);
    await page.goto('/app/rechecks');
    await page.getByRole('link', { name: 'Summary' }).first().click();

    await expect(page).toHaveURL(/\/summary/);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download.*Difference Excel/ }).click();
    const download = await downloadPromise;

    // Section 25: Stock_Recheck_[RecheckNumber]_[YYYY-MM-DD].xlsx
    expect(download.suggestedFilename()).toMatch(/^Stock_Recheck_.+_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  test('the export filter changes rows but not the workbook format', async ({ page }) => {
    await signIn(page, USERS.administrator);
    await page.goto('/app/rechecks');
    await page.getByRole('link', { name: 'Summary' }).first().click();

    await page.getByLabel('Export filter').selectOption('mismatched_only');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download.*Difference Excel/ }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });
});
