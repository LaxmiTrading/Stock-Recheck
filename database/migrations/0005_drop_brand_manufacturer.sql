-- ---------------------------------------------------------------------------
-- 0005 — remove brand and manufacturer.
--
-- Both were sourced ONLY from Zoho's per-item detail payload. Resolving them
-- therefore cost an extra HTTP request per SKU, which is what made a
-- 1200-row import exceed the platform's request budget and fail with an
-- unreadable (non-JSON) response.
--
-- Dropping them lets import validation resolve every SKU from Zoho's paginated
-- LIST endpoint, whose payload carries everything the snapshot still needs:
-- item_id, name, sku, status, product_type, track_inventory, stock_on_hand,
-- unit and vendor_name.
--
-- This is a one-way change: the stored values are deleted. They were display
-- and filter fields only — nothing counted, claimed, submitted or exported
-- depends on them, so no count, result or audit record is affected.
-- ---------------------------------------------------------------------------

-- The GIN index has to go FIRST: it is a functional index over an expression
-- naming both columns, so the DROP COLUMN below would otherwise fail.
DROP INDEX IF EXISTS sri_search_idx;

ALTER TABLE stock_recheck_items
  DROP COLUMN IF EXISTS brand_name,
  DROP COLUMN IF EXISTS manufacturer_name;

-- Rebuilt over the fields that remain, so workspace free-text search keeps
-- working across name, SKU and vendor.
CREATE INDEX sri_search_idx ON stock_recheck_items
  USING GIN (to_tsvector('simple',
    coalesce(item_name,'') || ' ' || coalesce(sku,'') || ' ' ||
    coalesce(vendor_name,'')));
