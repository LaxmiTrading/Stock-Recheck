-- ============================================================================
-- 0002 — Encrypted storage for the Zoho refresh token
--
-- Specification section 30.3 prefers environment variables for long-lived
-- secrets, and ZOHO_REFRESH_TOKEN remains the primary source. However, the
-- in-app OAuth flow (section 28.2 "Connect Zoho") produces a refresh token at
-- runtime, and section 32 forbids sending it to the frontend while section 29
-- forbids logging it. It therefore has to be persisted server-side.
--
-- It is stored encrypted with AES-256-GCM under a key derived from
-- ZOHO_TOKEN_KEY (falling back to AUTH_JWT_SECRET), so a database dump alone
-- does not yield a usable Zoho credential. This table is never exposed to
-- browser clients.
-- ============================================================================

ALTER TABLE zoho_connections
  ADD COLUMN refresh_token_encrypted TEXT,
  ADD COLUMN refresh_token_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN zoho_connections.refresh_token_encrypted IS
  'AES-256-GCM ciphertext (iv.tag.data, base64url). Server-only. Never returned by any API.';
