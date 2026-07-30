/**
 * Shapes returned by `GET /api/rechecks/:id/summary` and the item list.
 *
 * Extracted so the full Summary screen and the right-hand detail panel read the
 * same contract. When these were declared twice, a field added on one side was
 * silently missing on the other.
 */

import type { ItemWorkflowStatus, RecheckStatus, ResultStatus } from '@/domain/status';

export interface SummaryResponse {
  recheck: {
    id: string;
    recheckNumber: string;
    name: string;
    businessDate: string;
    status: RecheckStatus;
    organization: { name: string | null };
    stockBasis: {
      type: 'organization' | 'location' | 'warehouse';
      locationId: string | null;
      locationName: string | null;
      warehouseId: string | null;
      warehouseName: string | null;
    };
    zohoSnapshotAt: string;
    completionPercentage: number;
  };
  totals: {
    totalItems: number;
    submitted: number;
    remaining: number;
    countingInProgress: number;
    matched: number;
    mismatched: number;
    totalPositiveDifference: number;
    totalNegativeDifference: number;
  };
  isComplete: boolean;
  message: string;
}

export interface SummaryItem {
  id: string;
  itemName: string;
  sku: string;
  zohoStock: number | null;
  countedQuantity: number | null;
  quantityDifference: number | null;
  resultStatus: ResultStatus;
  workflowStatus: ItemWorkflowStatus;
  submittedByName: string | null;
  submittedAt: string | null;
  vendor: string | null;
  brand: string | null;
  manufacturer: string | null;
  unit: string | null;
}

export interface SummaryItemsResponse {
  items: SummaryItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
