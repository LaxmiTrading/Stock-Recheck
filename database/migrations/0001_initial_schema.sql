-- ============================================================================
-- 0001 — Initial schema
-- Specification section 30.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enums ----
CREATE TYPE user_role          AS ENUM ('administrator', 'counter');
CREATE TYPE user_status        AS ENUM ('active', 'disabled', 'invited');
CREATE TYPE stock_basis_type   AS ENUM ('organization', 'location', 'warehouse');
CREATE TYPE import_source_type AS ENUM ('excel', 'text');
CREATE TYPE import_batch_status
  AS ENUM ('draft', 'validating', 'validated', 'cancelled', 'consumed');
CREATE TYPE import_row_status
  AS ENUM ('pending', 'passed', 'failed', 'ignored_blank');
CREATE TYPE recheck_status
  AS ENUM ('draft', 'validating', 'ready', 'in_progress', 'completed', 'cancelled');
CREATE TYPE item_workflow_status
  AS ENUM ('available', 'counting_in_progress', 'submitted');
CREATE TYPE item_result_status AS ENUM ('pending', 'matched', 'mismatched');

-- ------------------------------------------------------------- 30.1 profiles
CREATE TABLE profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_user_id  TEXT UNIQUE,
  -- Stored verbatim; uniqueness and lookups go through lower(email) so the
  -- citext extension is not required (keeps the schema portable across
  -- Postgres providers, section 4.4).
  email             TEXT        NOT NULL,
  display_name      TEXT        NOT NULL,
  role              user_role   NOT NULL DEFAULT 'counter',
  status            user_status NOT NULL DEFAULT 'invited',

  -- Credentials live here because this deployment uses the built-in
  -- JWT authentication mechanism rather than an external identity provider.
  password_hash     TEXT,
  password_salt     TEXT,
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  reset_token_hash  TEXT,
  reset_expires_at  TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at     TIMESTAMPTZ,

  CONSTRAINT profiles_email_not_blank CHECK (length(trim(email)) > 0),
  CONSTRAINT profiles_display_name_not_blank CHECK (length(trim(display_name)) > 0),
  -- An active account must be able to authenticate.
  CONSTRAINT profiles_active_has_password
    CHECK (status <> 'active' OR password_hash IS NOT NULL)
);

-- Case-insensitive unique email without requiring the citext extension.
CREATE UNIQUE INDEX profiles_email_unique_idx ON profiles (lower(email));
CREATE INDEX profiles_role_status_idx ON profiles (role, status);
CREATE INDEX profiles_invite_token_idx ON profiles (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;
CREATE INDEX profiles_reset_token_idx ON profiles (reset_token_hash)
  WHERE reset_token_hash IS NOT NULL;

-- --------------------------------------------------------- 30.2 app_settings
-- Single-row table. `singleton` enforces that at the type level.
CREATE TABLE app_settings (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton                  BOOLEAN NOT NULL DEFAULT TRUE,

  business_name              TEXT    NOT NULL DEFAULT 'Stock Recheck',
  business_timezone          TEXT    NOT NULL DEFAULT 'Asia/Kolkata',
  date_format                TEXT    NOT NULL DEFAULT 'dd MMM yyyy',
  recheck_prefix             TEXT    NOT NULL DEFAULT 'SR',
  sku_case_sensitive         BOOLEAN NOT NULL DEFAULT FALSE,
  default_sort               TEXT    NOT NULL DEFAULT 'item_name',

  default_stock_basis_type   stock_basis_type NOT NULL DEFAULT 'organization',
  default_location_id        TEXT,
  default_location_name      TEXT,
  default_warehouse_id       TEXT,
  default_warehouse_name     TEXT,

  claim_lease_seconds        INTEGER NOT NULL DEFAULT 900,
  heartbeat_seconds          INTEGER NOT NULL DEFAULT 30,
  stale_claim_grace_seconds  INTEGER NOT NULL DEFAULT 60,
  counters_may_release_own   BOOLEAN NOT NULL DEFAULT TRUE,
  admins_may_force_release   BOOLEAN NOT NULL DEFAULT TRUE,

  blind_count_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  scanner_sound_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_success_sound      BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_error_sound        BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_success_flash      BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_error_flash        BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_require_enter      BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_auto_select_invalid BOOLEAN NOT NULL DEFAULT TRUE,
  scanner_prevent_sleep      BOOLEAN NOT NULL DEFAULT TRUE,

  max_import_rows            INTEGER NOT NULL DEFAULT 20000,
  max_file_size_bytes        BIGINT  NOT NULL DEFAULT 10485760,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                 UUID REFERENCES profiles (id) ON DELETE SET NULL,

  CONSTRAINT app_settings_singleton CHECK (singleton),
  CONSTRAINT app_settings_lease_positive CHECK (claim_lease_seconds >= 60),
  CONSTRAINT app_settings_heartbeat_positive CHECK (heartbeat_seconds >= 5),
  -- Section 28.4: heartbeat must be meaningfully shorter than the lease.
  CONSTRAINT app_settings_heartbeat_fits_lease
    CHECK (heartbeat_seconds * 3 <= claim_lease_seconds),
  CONSTRAINT app_settings_rows_positive CHECK (max_import_rows BETWEEN 1 AND 100000),
  CONSTRAINT app_settings_size_positive CHECK (max_file_size_bytes BETWEEN 1024 AND 52428800)
);

CREATE UNIQUE INDEX app_settings_singleton_idx ON app_settings (singleton);

-- ---------------------------------------------------- 30.3 zoho_connections
-- Server-only. Never exposed to browser clients.
-- Long-lived secrets live in environment variables, NOT in this table.
CREATE TABLE zoho_connections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton          BOOLEAN NOT NULL DEFAULT TRUE,
  organization_id    TEXT,
  organization_name  TEXT,
  accounts_domain    TEXT,
  api_domain         TEXT,
  data_center        TEXT,
  connection_status  TEXT NOT NULL DEFAULT 'not_configured',
  scope_summary      TEXT,
  connected_account  TEXT,
  last_success_at    TIMESTAMPTZ,
  last_failure_at    TIMESTAMPTZ,
  last_failure_code  TEXT,
  connected_at       TIMESTAMPTZ,
  connected_by       UUID REFERENCES profiles (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT zoho_connections_singleton CHECK (singleton),
  CONSTRAINT zoho_connections_status_valid CHECK (
    connection_status IN ('not_configured', 'connected', 'unhealthy', 'disconnected')
  )
);

CREATE UNIQUE INDEX zoho_connections_singleton_idx ON zoho_connections (singleton);

-- ------------------------------------------------------- 30.4 import_batches
CREATE TABLE import_batches (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type            import_source_type  NOT NULL,
  source_file_name       TEXT,
  worksheet_name         TEXT,
  mapped_sku_column      TEXT,
  header_row_number      INTEGER,
  status                 import_batch_status NOT NULL DEFAULT 'draft',

  total_source_rows      INTEGER NOT NULL DEFAULT 0,
  passed_rows            INTEGER NOT NULL DEFAULT 0,
  failed_rows            INTEGER NOT NULL DEFAULT 0,
  duplicate_rows         INTEGER NOT NULL DEFAULT 0,
  ignored_blank_rows     INTEGER NOT NULL DEFAULT 0,

  -- Basis captured at validation time so the snapshot is reproducible.
  stock_basis_type       stock_basis_type,
  stock_location_id      TEXT,
  stock_location_name    TEXT,
  stock_warehouse_id     TEXT,
  stock_warehouse_name   TEXT,
  zoho_organization_id   TEXT,
  zoho_organization_name TEXT,

  created_by             UUID NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validation_started_at  TIMESTAMPTZ,
  validation_finished_at TIMESTAMPTZ,

  CONSTRAINT import_batches_counts_non_negative CHECK (
    total_source_rows  >= 0 AND passed_rows        >= 0 AND
    failed_rows        >= 0 AND duplicate_rows     >= 0 AND
    ignored_blank_rows >= 0
  )
);

CREATE INDEX import_batches_created_by_idx ON import_batches (created_by, created_at DESC);
CREATE INDEX import_batches_status_idx ON import_batches (status);

-- ---------------------------------------------------------- 30.5 import_rows
CREATE TABLE import_rows (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id         UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  source_row_number       INTEGER NOT NULL,
  raw_sku                 TEXT NOT NULL DEFAULT '',
  display_sku             TEXT NOT NULL DEFAULT '',
  normalized_sku          TEXT NOT NULL DEFAULT '',
  validation_status       import_row_status NOT NULL DEFAULT 'pending',
  failure_code            TEXT,
  failure_reason          TEXT,
  duplicate_of_row_number INTEGER,
  zoho_item_id            TEXT,
  resolved_snapshot_json  JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT import_rows_source_row_positive CHECK (source_row_number >= 1),
  -- A failed row must always carry a reason (section 17).
  CONSTRAINT import_rows_failure_has_code
    CHECK (validation_status <> 'failed' OR failure_code IS NOT NULL),
  -- A passed row must carry the resolved Zoho snapshot.
  CONSTRAINT import_rows_passed_has_snapshot
    CHECK (validation_status <> 'passed'
           OR (zoho_item_id IS NOT NULL AND resolved_snapshot_json IS NOT NULL))
);

CREATE UNIQUE INDEX import_rows_batch_row_unique_idx
  ON import_rows (import_batch_id, source_row_number);
CREATE INDEX import_rows_batch_status_idx ON import_rows (import_batch_id, validation_status);
CREATE INDEX import_rows_batch_normalized_idx ON import_rows (import_batch_id, normalized_sku);

-- ------------------------------------------------------- 30.6 stock_rechecks
CREATE TABLE stock_rechecks (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recheck_number         TEXT NOT NULL,
  name                   TEXT NOT NULL,
  business_date          DATE NOT NULL,
  status                 recheck_status NOT NULL DEFAULT 'ready',

  import_batch_id        UUID REFERENCES import_batches (id) ON DELETE SET NULL,
  import_source_type     import_source_type,

  zoho_organization_id   TEXT,
  zoho_organization_name TEXT,

  -- Snapshot of the basis in force when the recheck was created. Changing the
  -- default basis later must never alter an existing recheck (section 28.3).
  stock_basis_type       stock_basis_type NOT NULL DEFAULT 'organization',
  stock_location_id      TEXT,
  stock_location_name    TEXT,
  stock_warehouse_id     TEXT,
  stock_warehouse_name   TEXT,
  zoho_snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  total_items            INTEGER NOT NULL DEFAULT 0,
  available_items        INTEGER NOT NULL DEFAULT 0,
  in_progress_items      INTEGER NOT NULL DEFAULT 0,
  submitted_items        INTEGER NOT NULL DEFAULT 0,
  matched_items          INTEGER NOT NULL DEFAULT 0,
  mismatched_items       INTEGER NOT NULL DEFAULT 0,

  created_by             UUID NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  cancelled_by           UUID REFERENCES profiles (id) ON DELETE SET NULL,
  cancellation_reason    TEXT,
  version                INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT stock_rechecks_number_unique UNIQUE (recheck_number),
  CONSTRAINT stock_rechecks_name_length CHECK (length(trim(name)) BETWEEN 1 AND 100),
  CONSTRAINT stock_rechecks_counters_non_negative CHECK (
    total_items       >= 0 AND available_items  >= 0 AND
    in_progress_items >= 0 AND submitted_items  >= 0 AND
    matched_items     >= 0 AND mismatched_items >= 0
  ),
  CONSTRAINT stock_rechecks_counters_reconcile CHECK (
    available_items + in_progress_items + submitted_items = total_items
  ),
  CONSTRAINT stock_rechecks_results_reconcile CHECK (
    matched_items + mismatched_items = submitted_items
  ),
  -- A location basis is meaningless without an identifier.
  CONSTRAINT stock_rechecks_basis_identified CHECK (
    (stock_basis_type = 'organization')
    OR (stock_basis_type = 'location'  AND stock_location_id  IS NOT NULL)
    OR (stock_basis_type = 'warehouse' AND stock_warehouse_id IS NOT NULL)
  )
);

CREATE INDEX stock_rechecks_status_idx ON stock_rechecks (status, business_date DESC);
CREATE INDEX stock_rechecks_business_date_idx ON stock_rechecks (business_date DESC);
CREATE INDEX stock_rechecks_created_by_idx ON stock_rechecks (created_by);
CREATE INDEX stock_rechecks_created_at_idx ON stock_rechecks (created_at DESC);

-- -------------------------------------------------- 30.7 stock_recheck_items
CREATE TABLE stock_recheck_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_recheck_id    UUID NOT NULL REFERENCES stock_rechecks (id) ON DELETE CASCADE,

  -- Immutable Zoho snapshot (section 2.6).
  zoho_item_id        TEXT NOT NULL,
  item_name           TEXT NOT NULL,
  sku                 TEXT NOT NULL,
  normalized_sku      TEXT NOT NULL,
  zoho_stock_quantity NUMERIC(18, 4) NOT NULL,
  vendor_name         TEXT,
  brand_name          TEXT,
  manufacturer_name   TEXT,
  unit                TEXT,
  item_group_id       TEXT,
  zoho_snapshot_json  JSONB,

  workflow_status     item_workflow_status NOT NULL DEFAULT 'available',
  result_status       item_result_status   NOT NULL DEFAULT 'pending',

  claimed_by          UUID REFERENCES profiles (id) ON DELETE SET NULL,
  claimed_at          TIMESTAMPTZ,
  claim_expires_at    TIMESTAMPTZ,
  -- Incremented on every successful claim. A local draft written under an
  -- older version can never be restored against a newer claim (section 22).
  claim_version       INTEGER NOT NULL DEFAULT 0,

  counted_quantity    INTEGER,
  quantity_difference NUMERIC(18, 4),
  submitted_by        UUID REFERENCES profiles (id) ON DELETE SET NULL,
  submitted_at        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_version         INTEGER NOT NULL DEFAULT 1,

  -- A SKU appears at most once per recheck (section 3.2).
  CONSTRAINT stock_recheck_items_sku_unique UNIQUE (stock_recheck_id, normalized_sku),
  CONSTRAINT stock_recheck_items_count_non_negative
    CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  -- Difference is null before submission.
  CONSTRAINT stock_recheck_items_difference_before_submit
    CHECK (submitted_at IS NOT NULL OR quantity_difference IS NULL),
  -- A submitted item carries quantity, difference, user and time.
  CONSTRAINT stock_recheck_items_submitted_complete CHECK (
    workflow_status <> 'submitted'
    OR (counted_quantity IS NOT NULL AND quantity_difference IS NOT NULL
        AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  -- An available item must not carry an active claimant.
  CONSTRAINT stock_recheck_items_available_unclaimed CHECK (
    workflow_status <> 'available'
    OR (claimed_by IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL)
  ),
  -- A claimed item must carry the full claim triple.
  CONSTRAINT stock_recheck_items_claimed_complete CHECK (
    workflow_status <> 'counting_in_progress'
    OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  -- Result status is pending until submission.
  CONSTRAINT stock_recheck_items_result_after_submit CHECK (
    (workflow_status = 'submitted') = (result_status <> 'pending')
  )
);

CREATE INDEX sri_recheck_idx           ON stock_recheck_items (stock_recheck_id);
CREATE INDEX sri_workflow_status_idx   ON stock_recheck_items (stock_recheck_id, workflow_status);
CREATE INDEX sri_result_status_idx     ON stock_recheck_items (stock_recheck_id, result_status);
CREATE INDEX sri_claimed_by_idx        ON stock_recheck_items (claimed_by)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX sri_claim_expiry_idx      ON stock_recheck_items (claim_expires_at)
  WHERE claim_expires_at IS NOT NULL;
CREATE INDEX sri_normalized_sku_idx    ON stock_recheck_items (normalized_sku);
CREATE INDEX sri_submitted_at_idx      ON stock_recheck_items (submitted_at DESC)
  WHERE submitted_at IS NOT NULL;
CREATE INDEX sri_item_name_idx         ON stock_recheck_items (stock_recheck_id, item_name);
-- Supports the workspace free-text search across name/sku/vendor/brand/mfr.
CREATE INDEX sri_search_idx ON stock_recheck_items
  USING GIN (to_tsvector('simple',
    coalesce(item_name,'') || ' ' || coalesce(sku,'') || ' ' ||
    coalesce(vendor_name,'') || ' ' || coalesce(brand_name,'') || ' ' ||
    coalesce(manufacturer_name,'')));

-- ---------------------------------------------------------- 30.8 audit_events
CREATE TABLE audit_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type            TEXT NOT NULL,
  actor_user_id         UUID REFERENCES profiles (id) ON DELETE SET NULL,
  -- Snapshot so the log stays readable after a rename or account removal.
  actor_display_name    TEXT,
  stock_recheck_id      UUID REFERENCES stock_rechecks (id) ON DELETE SET NULL,
  stock_recheck_item_id UUID REFERENCES stock_recheck_items (id) ON DELETE SET NULL,
  metadata_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id        TEXT,
  request_ip            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_created_at_idx ON audit_events (created_at DESC);
CREATE INDEX audit_events_type_idx       ON audit_events (event_type, created_at DESC);
CREATE INDEX audit_events_actor_idx      ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_recheck_idx    ON audit_events (stock_recheck_id, created_at DESC);

-- ----------------------------------------------------- 30.9 idempotency_keys
CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  operation_type  TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',

  CONSTRAINT idempotency_keys_unique UNIQUE (user_id, operation_type, idempotency_key)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ------------------------------------------------ 39 count_submission_history
-- Audit-grade history. A reopened item never overwrites its previous record.
CREATE TABLE count_submission_history (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_recheck_item_id  UUID NOT NULL REFERENCES stock_recheck_items (id) ON DELETE CASCADE,
  attempt_number         INTEGER NOT NULL,
  counted_quantity       INTEGER NOT NULL,
  zoho_stock_quantity    NUMERIC(18, 4) NOT NULL,
  quantity_difference    NUMERIC(18, 4) NOT NULL,
  result_status          item_result_status NOT NULL,
  submitted_by           UUID REFERENCES profiles (id) ON DELETE SET NULL,
  submitted_at           TIMESTAMPTZ NOT NULL,
  reopened_by            UUID REFERENCES profiles (id) ON DELETE SET NULL,
  reopened_at            TIMESTAMPTZ,
  reopen_reason          TEXT,
  is_current             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT csh_attempt_positive CHECK (attempt_number >= 1),
  CONSTRAINT csh_attempt_unique UNIQUE (stock_recheck_item_id, attempt_number)
);

-- At most one current submission per item.
CREATE UNIQUE INDEX csh_one_current_idx
  ON count_submission_history (stock_recheck_item_id)
  WHERE is_current;

-- --------------------------------------------------------- zoho_item_cache --
-- Section 32 "Caching". Reduces repeated Zoho reads during validation.
CREATE TABLE zoho_item_cache (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_item_id   TEXT NOT NULL,
  sku            TEXT,
  normalized_sku TEXT NOT NULL,
  item_payload   JSONB NOT NULL,
  group_payload  JSONB,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,

  CONSTRAINT zoho_item_cache_unique UNIQUE (normalized_sku)
);

CREATE INDEX zoho_item_cache_expiry_idx ON zoho_item_cache (expires_at);
CREATE INDEX zoho_item_cache_item_id_idx ON zoho_item_cache (zoho_item_id);

-- ------------------------------------------------------------ rate_limits --
-- Section 34. Small fixed-window counter table; adequate for the request
-- volumes this application sees and avoids adding a Redis dependency.
CREATE TABLE rate_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_key   TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count    INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT rate_limits_unique UNIQUE (bucket_key, window_start)
);

CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

-- ----------------------------------------------------- updated_at triggers --
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at            BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER app_settings_updated_at        BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER zoho_connections_updated_at    BEFORE UPDATE ON zoho_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER import_batches_updated_at      BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER import_rows_updated_at         BEFORE UPDATE ON import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_rechecks_updated_at      BEFORE UPDATE ON stock_rechecks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_recheck_items_updated_at BEFORE UPDATE ON stock_recheck_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the singleton settings row.
INSERT INTO app_settings (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
INSERT INTO zoho_connections (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
