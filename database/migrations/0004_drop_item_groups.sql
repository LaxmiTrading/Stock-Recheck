-- ---------------------------------------------------------------------------
-- 0004 — drop the item-group column.
--
-- The integration reads Zoho BOOKS, not Zoho Inventory. Item groups are an
-- Inventory-only concept: Books has no `/itemgroups` endpoint and no group
-- record on an item, so this column can never be populated again.
--
-- Leaving a permanently-NULL column behind is worse than dropping it — it reads
-- like a feature that exists, and the next person to touch the import path
-- would reasonably try to fill it.
--
-- Nothing else depends on it: it was written once at import time and only ever
-- read back as part of the item projection. No index, constraint or foreign key
-- references it, and it is not part of the permanent record required by section
-- 2.2 (final counted quantity, submitter, submission time, Zoho snapshot,
-- difference, result status).
--
-- The historical values are NOT preserved. They are Zoho Inventory group ids
-- that no longer resolve against the Books account this application now reads.
-- ---------------------------------------------------------------------------

ALTER TABLE stock_recheck_items
  DROP COLUMN IF EXISTS item_group_id;
