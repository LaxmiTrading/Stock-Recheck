/**
 * Dashboard endpoint — specification section 10.
 *
 *   GET /api/dashboard
 *
 * Returns the card set appropriate to the caller's role plus the active
 * Stock Recheck list. Administrators and counters get different cards, so the
 * shape is discriminated by `role`.
 */

import type { Config, Context } from '@netlify/functions';
import { calculateCompletionPercentage } from '../../src/domain/status';
import { requireUser } from '../shared/auth/session';
import { jsonSuccess, withErrorHandling } from '../shared/http';
import { findActiveClaimForUser } from '../shared/repositories/items';
import { getDashboardCounts, listActiveRechecks } from '../shared/repositories/rechecks';
import { getSettings } from '../shared/repositories/settings';

const handler = withErrorHandling('dashboard', async (request, context) => {
  const actor = await requireUser(request);
  const settings = await getSettings();

  const [counts, activeRechecks, activeClaim] = await Promise.all([
    getDashboardCounts({ userId: actor.id, timezone: settings.businessTimezone }),
    listActiveRechecks(20),
    findActiveClaimForUser(actor.id),
  ]);

  const rechecks = activeRechecks.map((recheck) => ({
    id: recheck.id,
    recheckNumber: recheck.recheck_number,
    name: recheck.name,
    businessDate: recheck.business_date,
    status: recheck.status,
    createdByName: recheck.created_by_name,
    totalItems: recheck.total_items,
    availableItems: recheck.available_items,
    inProgressItems: recheck.in_progress_items,
    submittedItems: recheck.submitted_items,
    completionPercentage: calculateCompletionPercentage({
      submittedItems: recheck.submitted_items,
      totalItems: recheck.total_items,
    }),
  }));

  // Section 10 defines distinct card sets per role.
  const cards =
    actor.role === 'administrator'
      ? {
          role: 'administrator' as const,
          activeStockRechecks: counts.activeRechecks,
          itemsAvailable: counts.itemsAvailable,
          itemsCountingInProgress: counts.itemsCountingInProgress,
          itemsSubmittedToday: counts.itemsSubmittedToday,
          mismatchedItemsToday: counts.mismatchedItemsToday,
          completedStockRechecksToday: counts.completedRechecksToday,
        }
      : {
          role: 'counter' as const,
          myClaimedItem:
            activeClaim === null
              ? null
              : {
                  itemId: activeClaim.item_id,
                  recheckId: activeClaim.stock_recheck_id,
                  recheckNumber: activeClaim.recheck_number,
                  itemName: activeClaim.item_name,
                  sku: activeClaim.sku,
                  claimExpiresAt: activeClaim.claim_expires_at,
                },
          availableItems: counts.itemsAvailable,
          mySubmittedItemsToday: counts.mySubmittedItemsToday,
          activeStockRechecks: counts.activeRechecks,
        };

  return jsonSuccess(
    {
      cards,
      activeRechecks: rechecks,
      activeClaim:
        activeClaim === null
          ? null
          : {
              itemId: activeClaim.item_id,
              recheckId: activeClaim.stock_recheck_id,
              recheckNumber: activeClaim.recheck_number,
              itemName: activeClaim.item_name,
              sku: activeClaim.sku,
              claimExpiresAt: activeClaim.claim_expires_at,
            },
    },
    context.correlationId,
  );
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = { path: '/api/dashboard' };
