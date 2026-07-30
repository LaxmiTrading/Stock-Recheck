-- ---------------------------------------------------------------------------
-- 0003 — exactly one administrator.
--
-- The application is specified to have a single administrator login; every
-- other user is a counter. Enforcing that in the schema means no code path —
-- a future endpoint, a hand-written UPDATE, a re-run seed — can quietly
-- produce a second one.
--
-- Nothing here touches the audit trail or any permanent record: only the
-- `role` column changes, and only for accounts that were surplus
-- administrators. Their history, submissions and audit events are untouched,
-- and the accounts keep working — as counters.
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------- 1. reconcile first
-- A UNIQUE index cannot be created while the data already violates it, and
-- deployments may already have several administrators. Keep the OLDEST
-- administrator — that is the account the system was bootstrapped with, so it
-- is the one guaranteed to have a usable password rather than a pending
-- invitation — and demote the rest to counter.
--
-- `ctid` is the tie-breaker for identical created_at values (the seed inserts
-- every profile in a single statement, so its timestamps are identical); an
-- ORDER BY that is not total would make the choice non-deterministic.
UPDATE profiles
   SET role = 'counter',
       updated_at = NOW()
 WHERE role = 'administrator'
   AND id <> (
     SELECT id
       FROM profiles
      WHERE role = 'administrator'
      ORDER BY created_at ASC, ctid ASC
      LIMIT 1
   );

-- ------------------------------------------------------- 2. enforce the rule
-- A partial UNIQUE index restricted to administrator rows: every such row
-- occupies the same key, so a second one conflicts on INSERT or UPDATE.
--
-- "At most one" rather than "exactly one": SQL cannot express a non-empty
-- requirement as an index, and a hard floor would make the first insert
-- impossible. The lower bound — never demote or disable the last
-- administrator — is enforced in the admin API, which can return an
-- explanatory error instead of a constraint violation.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_single_administrator_idx
  ON profiles (role)
  WHERE role = 'administrator';
