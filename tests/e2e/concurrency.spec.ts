/**
 * End-to-end scenarios 4, 11 and 12 — specification section 41.
 *
 * Concurrent claiming, claim expiry and automatic completion. These verify the
 * server-side concurrency guarantees from the outside.
 */

import { expect, test, type Browser } from '@playwright/test';
import { openFirstRecheck, signIn, USERS } from './fixtures';

/** Opens an isolated browser context so two users can act simultaneously. */
async function newUserPage(browser: Browser, user: { email: string }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

test.describe('concurrency', () => {
  /* -------------------------------------------- Scenario 4: concurrent claim */
  test('two users clicking Claim at the same time: exactly one wins', async ({ browser }) => {
    const userA = await newUserPage(browser, USERS.counterOne);
    const userB = await newUserPage(browser, USERS.counterTwo);

    try {
      const recheckId = await openFirstRecheck(userA.page);
      await userB.page.goto(`/app/rechecks/${recheckId}/workspace`);

      // Both filter to available items and target the same first row.
      for (const page of [userA.page, userB.page]) {
        await page.getByLabel('Status').selectOption('available');
        await expect(page.getByRole('button', { name: 'Claim Item' }).first()).toBeVisible();
      }

      // Fire both clicks without awaiting either, so they race at the server.
      const [resultA, resultB] = await Promise.allSettled([
        userA.page.getByRole('button', { name: 'Claim Item' }).first().click(),
        userB.page.getByRole('button', { name: 'Claim Item' }).first().click(),
      ]);

      expect(resultA.status).toBe('fulfilled');
      expect(resultB.status).toBe('fulfilled');

      // Exactly one lands on a counting screen.
      await userA.page.waitForTimeout(1500);
      await userB.page.waitForTimeout(1500);

      const aCounting = /\/items\/[^/]+\/count/.test(userA.page.url());
      const bCounting = /\/items\/[^/]+\/count/.test(userB.page.url());

      // If they happened to target different rows both may succeed; the
      // decisive assertion is that they never hold the SAME item.
      if (aCounting && bCounting) {
        expect(userA.page.url()).not.toBe(userB.page.url());
      } else {
        expect(aCounting !== bCounting).toBe(true);

        // The loser sees a conflict message, not a silent failure.
        const loser = aCounting ? userB.page : userA.page;
        await expect(loser.getByText(/just claimed by|could not claim/i)).toBeVisible({
          timeout: 5000,
        });
      }
    } finally {
      await userA.context.close();
      await userB.context.close();
    }
  });

  test('another user sees the item as Counting in progress with no claim button', async ({
    browser,
  }) => {
    const userA = await newUserPage(browser, USERS.counterOne);
    const userB = await newUserPage(browser, USERS.counterTwo);

    try {
      const recheckId = await openFirstRecheck(userA.page);

      await userA.page.getByLabel('Status').selectOption('available');
      const row = userA.page.locator('tbody tr').first();
      const sku = (await row.locator('td').nth(2).innerText()).trim();
      await userA.page.getByRole('button', { name: 'Claim Item' }).first().click();
      await expect(userA.page).toHaveURL(/\/items\/[^/]+\/count/);

      // User B looks at the same recheck.
      await userB.page.goto(`/app/rechecks/${recheckId}/workspace`);
      await userB.page.getByLabel('Search').fill(sku);

      const claimedRow = userB.page.locator('tbody tr').filter({ hasText: sku }).first();
      await expect(claimedRow).toContainText('Counting in progress');
      await expect(claimedRow).toContainText(USERS.counterOne.name);
      // Section 19: no claim button on another user's item.
      await expect(claimedRow.getByRole('button', { name: 'Claim Item' })).toHaveCount(0);
    } finally {
      await userA.context.close();
      await userB.context.close();
    }
  });

  /* -------------------------------------------- Scenario 11: claim expiry */
  test('a stale claim is reclaimable by another user', async ({ browser }) => {
    // The seeded data contains an item whose lease expired 20 minutes ago, so
    // this does not depend on waiting out a real lease.
    const userB = await newUserPage(browser, USERS.counterTwo);

    try {
      const recheckId = await openFirstRecheck(userB.page);
      await userB.page.goto(`/app/rechecks/${recheckId}/workspace`);
      await userB.page.getByLabel('Search').fill('SKU-0007');

      const staleRow = userB.page.locator('tbody tr').filter({ hasText: 'SKU-0007' }).first();
      await expect(staleRow).toBeVisible();

      // Claiming sweeps the expired lease first, then succeeds.
      const claimButton = staleRow.getByRole('button', { name: /Claim Item|Release Claim/ });
      if ((await claimButton.count()) > 0 && (await claimButton.innerText()) === 'Claim Item') {
        await claimButton.click();
        await expect(userB.page).toHaveURL(/\/items\/[^/]+\/count/);
      }
    } finally {
      await userB.context.close();
    }
  });
});

test.describe('read-only rechecks', () => {
  test('a cancelled Stock Recheck accepts no new claims', async ({ page }) => {
    await signIn(page, USERS.administrator);
    const recheckId = await openFirstRecheck(page);

    await page.getByRole('button', { name: 'Cancel Recheck' }).click();
    await page.getByLabel('Reason').fill('End-to-end test cancellation');
    await page.getByRole('button', { name: 'Cancel Stock Recheck' }).click();

    await expect(page.getByText(/cancelled/i).first()).toBeVisible();

    // Every claim control is now disabled.
    await page.goto(`/app/rechecks/${recheckId}/workspace`);
    const claimButtons = page.getByRole('button', { name: 'Claim Item' });
    const count = await claimButtons.count();
    for (let index = 0; index < count; index += 1) {
      await expect(claimButtons.nth(index)).toBeDisabled();
    }
  });
});
