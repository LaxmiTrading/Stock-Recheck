/**
 * Role capability matrix — specification section 4.5.
 *
 * Centralized per section 44 ("Centralized permission checks"). The frontend
 * uses this to hide controls; every serverless function ALSO calls `can()`
 * before acting. Hiding a button is never the enforcement mechanism.
 */

export const ROLES = ['administrator', 'counter'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  administrator: 'Administrator',
  counter: 'Counter',
};

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Every distinct capability in the product. */
export const PERMISSIONS = [
  'recheck:create',
  'recheck:import',
  'recheck:view_all',
  'recheck:cancel',
  'recheck:export',
  'item:claim',
  'item:count',
  'item:release_own',
  'item:force_release',
  'item:reopen',
  // Correcting the counted quantity on an already-submitted item. Kept out of
  // COUNTER_PERMISSIONS because section 4.5 states a counter "cannot modify
  // completed counts"; move it there if self-correction is wanted.
  'item:amend',
  'result:view_all',
  'user:manage',
  'settings:view',
  'settings:manage',
  'zoho:configure',
  'zoho:view_integration_detail',
  'audit:view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Administrators hold every capability. Counters hold the operational subset.
 *
 * Explicitly NOT granted to counters (section 4.5 "Cannot"):
 *   import SKUs, change Zoho settings, manage users, cancel rechecks,
 *   release another user's claim, modify completed counts, reopen completed
 *   items, access sensitive integration information.
 */
const COUNTER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'item:claim',
  'item:count',
  'item:release_own',
  'result:view_all',
  'settings:view',
]);

export function can(role: Role, permission: Permission): boolean {
  if (role === 'administrator') return true;
  return COUNTER_PERMISSIONS.has(permission);
}

export function canAll(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => can(role, permission));
}

export function canAny(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(role, permission));
}

export function isAdministrator(role: Role): boolean {
  return role === 'administrator';
}

/** Minimal identity shape the permission helpers need. */
export interface ActorLike {
  readonly id: string;
  readonly role: Role;
  readonly status: UserStatus;
}

/** A disabled account holds no capabilities at all (section 27, "Disable User"). */
export function actorCan(actor: ActorLike, permission: Permission): boolean {
  if (actor.status !== 'active') return false;
  return can(actor.role, permission);
}

/**
 * Claim-release authorization — section 19 "Release Claim".
 *
 * A counter may release only their OWN claim, and only when the administrator
 * has left that setting enabled. An administrator may force-release anyone's,
 * subject to the same settings gate.
 */
export function canReleaseClaim(
  actor: ActorLike,
  claimOwnerId: string | null,
  settings: { countersMayReleaseOwnClaims: boolean; adminsMayForceRelease: boolean },
): boolean {
  if (actor.status !== 'active') return false;
  if (claimOwnerId === null) return false;

  const isOwnClaim = claimOwnerId === actor.id;
  if (isOwnClaim) {
    if (actor.role === 'administrator') return true;
    return settings.countersMayReleaseOwnClaims;
  }
  return actor.role === 'administrator' && settings.adminsMayForceRelease;
}

/**
 * This deployment runs with exactly ONE administrator login; every other user
 * is a counter.
 *
 * The floor and the ceiling are enforced in different places for different
 * reasons. The ceiling is a partial unique index in the database
 * (`profiles_single_administrator_idx`), so no code path can produce a second
 * administrator. The floor cannot be an index — SQL has no "at least one row"
 * constraint — so it lives in `blockRoleChangeReason` / `blockDisableReason`,
 * which can also explain themselves to the caller.
 */
export const MAX_ADMINISTRATORS = 1;

/**
 * Guards the ceiling: refuses to create a second administrator.
 *
 * `administratorCount` must count administrators of EVERY status, matching the
 * database index. An invited-but-not-yet-accepted administrator still occupies
 * the single slot.
 */
export function blockPromotionReason(params: {
  targetCurrentRole: Role;
  targetNewRole: Role;
  administratorCount: number;
}): string | null {
  const { targetCurrentRole, targetNewRole, administratorCount } = params;

  if (targetNewRole !== 'administrator') return null;
  // Already an administrator: re-asserting the same role adds no second one.
  if (targetCurrentRole === 'administrator') return null;
  if (administratorCount < MAX_ADMINISTRATORS) return null;

  return 'There can only be one administrator, and one already exists. The administrator role cannot be transferred from this screen.';
}

/**
 * Guards the last-administrator invariant — section 27 "Change Role".
 * Returns a reason string when the change must be blocked, otherwise null.
 */
export function blockRoleChangeReason(params: {
  actorId: string;
  targetUserId: string;
  targetCurrentRole: Role;
  targetNewRole: Role;
  activeAdministratorCount: number;
}): string | null {
  const { actorId, targetUserId, targetCurrentRole, targetNewRole, activeAdministratorCount } =
    params;

  if (targetCurrentRole === targetNewRole) return null;
  if (targetCurrentRole !== 'administrator') return null;

  if (activeAdministratorCount <= 1) {
    return 'This is the last active administrator. Promote another user before changing this role.';
  }
  if (actorId === targetUserId) {
    // Permitted only because another administrator remains.
    return null;
  }
  return null;
}

/** Same invariant, applied to disabling an account. */
export function blockDisableReason(params: {
  actorId: string;
  targetUserId: string;
  targetRole: Role;
  activeAdministratorCount: number;
}): string | null {
  if (params.actorId === params.targetUserId) {
    return 'You cannot disable your own account.';
  }
  if (params.targetRole === 'administrator' && params.activeAdministratorCount <= 1) {
    return 'This is the last active administrator and cannot be disabled.';
  }
  return null;
}
