/**
 * Profiles repository — specification sections 4.5, 27.
 */

import type { Role } from '../../../src/domain/permissions';
import { query, queryMany, queryOne } from '../database/client';

export type ProfileStatus = 'active' | 'disabled' | 'invited';

export interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: ProfileStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface ProfileCredentialRow extends ProfileRow {
  password_hash: string | null;
  password_salt: string | null;
}

const PUBLIC_COLUMNS = 'id, email, display_name, role, status, created_at, updated_at, last_login_at';

export async function findProfileById(id: string): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>(`SELECT ${PUBLIC_COLUMNS} FROM profiles WHERE id = $1`, [id]);
}

/** Case-insensitive lookup, matching the `lower(email)` unique index. */
export async function findProfileByEmail(email: string): Promise<ProfileCredentialRow | null> {
  return queryOne<ProfileCredentialRow>(
    `SELECT ${PUBLIC_COLUMNS}, password_hash, password_salt
       FROM profiles WHERE lower(email) = lower($1)`,
    [email],
  );
}

export async function findProfileByInviteToken(
  tokenHash: string,
): Promise<(ProfileRow & { invite_expires_at: string | null }) | null> {
  return queryOne(
    `SELECT ${PUBLIC_COLUMNS}, invite_expires_at
       FROM profiles WHERE invite_token_hash = $1`,
    [tokenHash],
  );
}

export async function findProfileByResetToken(
  tokenHash: string,
): Promise<(ProfileRow & { reset_expires_at: string | null }) | null> {
  return queryOne(
    `SELECT ${PUBLIC_COLUMNS}, reset_expires_at
       FROM profiles WHERE reset_token_hash = $1`,
    [tokenHash],
  );
}

export interface UserListRow extends ProfileRow {
  active_claim_item_id: string | null;
  active_claim_item_name: string | null;
}

/** User list with each user's active claim — section 27. */
export async function listProfiles(): Promise<UserListRow[]> {
  return queryMany<UserListRow>(
    `SELECT p.id, p.email, p.display_name, p.role, p.status,
            p.created_at, p.updated_at, p.last_login_at,
            claim.id        AS active_claim_item_id,
            claim.item_name AS active_claim_item_name
       FROM profiles p
       LEFT JOIN LATERAL (
         SELECT i.id, i.item_name
           FROM stock_recheck_items i
          WHERE i.claimed_by = p.id
            AND i.workflow_status = 'counting_in_progress'
            AND i.claim_expires_at > NOW()
          ORDER BY i.claimed_at DESC
          LIMIT 1
       ) claim ON TRUE
      ORDER BY p.display_name ASC`,
  );
}

export async function countActiveAdministrators(): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM profiles
      WHERE role = 'administrator' AND status = 'active'`,
  );
  return row?.total ?? 0;
}

/**
 * Administrators of ANY status — active, invited or disabled.
 *
 * This is the count the single-administrator rule must be checked against,
 * because the `profiles_single_administrator_idx` partial unique index does not
 * look at `status` either. Checking only ACTIVE administrators would let an
 * invitation for a second administrator pass validation and then fail on the
 * index as an unhandled 500 instead of a clean 409.
 */
export async function countAdministrators(): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM profiles WHERE role = 'administrator'`,
  );
  return row?.total ?? 0;
}

export interface InviteUserInput {
  email: string;
  displayName: string;
  role: Role;
  inviteTokenHash: string;
  inviteExpiresAt: Date;
}

export async function insertInvitedProfile(input: InviteUserInput): Promise<ProfileRow> {
  const row = await queryOne<ProfileRow>(
    `INSERT INTO profiles (email, display_name, role, status, invite_token_hash, invite_expires_at)
     VALUES ($1, $2, $3, 'invited', $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [input.email, input.displayName, input.role, input.inviteTokenHash, input.inviteExpiresAt],
  );
  if (row === null) throw new Error('Profile insert returned no row');
  return row;
}

/** Re-issues an invitation for a profile that has not accepted yet. */
export async function refreshInvite(params: {
  profileId: string;
  inviteTokenHash: string;
  inviteExpiresAt: Date;
  role: Role;
  displayName: string;
}): Promise<void> {
  await query(
    `UPDATE profiles
        SET invite_token_hash = $2, invite_expires_at = $3, role = $4, display_name = $5
      WHERE id = $1 AND status = 'invited'`,
    [
      params.profileId,
      params.inviteTokenHash,
      params.inviteExpiresAt,
      params.role,
      params.displayName,
    ],
  );
}

/** Completes an invitation: sets the password and activates the account. */
export async function activateProfileWithPassword(params: {
  profileId: string;
  passwordHash: string;
  passwordSalt: string;
}): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>(
    `UPDATE profiles
        SET password_hash = $2, password_salt = $3,
            status = 'active',
            invite_token_hash = NULL, invite_expires_at = NULL,
            reset_token_hash = NULL, reset_expires_at = NULL
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [params.profileId, params.passwordHash, params.passwordSalt],
  );
}

export async function setResetToken(params: {
  profileId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await query(
    'UPDATE profiles SET reset_token_hash = $2, reset_expires_at = $3 WHERE id = $1',
    [params.profileId, params.tokenHash, params.expiresAt],
  );
}

export async function recordLogin(profileId: string): Promise<void> {
  await query('UPDATE profiles SET last_login_at = NOW() WHERE id = $1', [profileId]);
}

export async function updateProfileRole(profileId: string, role: Role): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>(
    `UPDATE profiles SET role = $2 WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [profileId, role],
  );
}

export async function updateProfileStatus(
  profileId: string,
  status: 'active' | 'disabled',
): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>(
    `UPDATE profiles SET status = $2 WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [profileId, status],
  );
}

export async function updateDisplayName(
  profileId: string,
  displayName: string,
): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>(
    `UPDATE profiles SET display_name = $2 WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [profileId, displayName],
  );
}

export async function updatePassword(params: {
  profileId: string;
  passwordHash: string;
  passwordSalt: string;
}): Promise<void> {
  await query(
    `UPDATE profiles
        SET password_hash = $2, password_salt = $3,
            reset_token_hash = NULL, reset_expires_at = NULL
      WHERE id = $1`,
    [params.profileId, params.passwordHash, params.passwordSalt],
  );
}
