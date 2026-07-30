/**
 * Role capability matrix — specification section 4.5.
 */

import { describe, expect, it } from 'vitest';
import {
  actorCan,
  blockDisableReason,
  blockPromotionReason,
  blockRoleChangeReason,
  can,
  canReleaseClaim,
  isAdministrator,
  type ActorLike,
} from '@/domain/permissions';

const ADMIN: ActorLike = { id: 'admin-1', role: 'administrator', status: 'active' };
const COUNTER: ActorLike = { id: 'counter-1', role: 'counter', status: 'active' };
const DISABLED: ActorLike = { id: 'counter-2', role: 'counter', status: 'disabled' };

describe('can — administrator', () => {
  it('grants every capability', () => {
    for (const permission of [
      'recheck:create',
      'recheck:import',
      'recheck:cancel',
      'user:manage',
      'zoho:configure',
      'audit:view',
      'item:force_release',
      'item:reopen',
    ] as const) {
      expect(can('administrator', permission)).toBe(true);
    }
  });
});

describe('can — counter', () => {
  it('grants the operational subset', () => {
    expect(can('counter', 'item:claim')).toBe(true);
    expect(can('counter', 'item:count')).toBe(true);
    expect(can('counter', 'item:release_own')).toBe(true);
    expect(can('counter', 'result:view_all')).toBe(true);
  });

  it('withholds everything the specification lists under "Cannot"', () => {
    expect(can('counter', 'recheck:import')).toBe(false);
    expect(can('counter', 'zoho:configure')).toBe(false);
    expect(can('counter', 'user:manage')).toBe(false);
    expect(can('counter', 'recheck:cancel')).toBe(false);
    expect(can('counter', 'item:force_release')).toBe(false);
    expect(can('counter', 'item:reopen')).toBe(false);
    expect(can('counter', 'zoho:view_integration_detail')).toBe(false);
    expect(can('counter', 'audit:view')).toBe(false);
    expect(can('counter', 'settings:manage')).toBe(false);
  });
});

describe('actorCan', () => {
  it('grants nothing at all to a disabled account', () => {
    expect(actorCan(DISABLED, 'item:claim')).toBe(false);
    expect(actorCan({ ...ADMIN, status: 'disabled' }, 'user:manage')).toBe(false);
  });

  it('respects the role for an active account', () => {
    expect(actorCan(COUNTER, 'item:claim')).toBe(true);
    expect(actorCan(COUNTER, 'recheck:import')).toBe(false);
  });
});

describe('isAdministrator', () => {
  it('discriminates the two roles', () => {
    expect(isAdministrator('administrator')).toBe(true);
    expect(isAdministrator('counter')).toBe(false);
  });
});

describe('canReleaseClaim (section 19)', () => {
  const permissive = { countersMayReleaseOwnClaims: true, adminsMayForceRelease: true };
  const restrictive = { countersMayReleaseOwnClaims: false, adminsMayForceRelease: false };

  it('lets a counter release their OWN claim when enabled', () => {
    expect(canReleaseClaim(COUNTER, COUNTER.id, permissive)).toBe(true);
  });

  it('blocks a counter from releasing their own claim when disabled', () => {
    expect(canReleaseClaim(COUNTER, COUNTER.id, restrictive)).toBe(false);
  });

  it('never lets a counter release ANOTHER user’s claim', () => {
    expect(canReleaseClaim(COUNTER, 'someone-else', permissive)).toBe(false);
    expect(canReleaseClaim(COUNTER, 'someone-else', restrictive)).toBe(false);
  });

  it('lets an administrator force-release when enabled', () => {
    expect(canReleaseClaim(ADMIN, 'someone-else', permissive)).toBe(true);
  });

  it('blocks an administrator force-release when the setting is off', () => {
    expect(canReleaseClaim(ADMIN, 'someone-else', restrictive)).toBe(false);
  });

  it('lets an administrator always release their own claim', () => {
    expect(canReleaseClaim(ADMIN, ADMIN.id, restrictive)).toBe(true);
  });

  it('returns false when there is no claim to release', () => {
    expect(canReleaseClaim(ADMIN, null, permissive)).toBe(false);
  });
});

describe('blockRoleChangeReason (section 27)', () => {
  it('blocks demoting the last active administrator', () => {
    const reason = blockRoleChangeReason({
      actorId: 'admin-1',
      targetUserId: 'admin-1',
      targetCurrentRole: 'administrator',
      targetNewRole: 'counter',
      activeAdministratorCount: 1,
    });
    expect(reason).not.toBeNull();
  });

  it('allows the demotion when another administrator remains', () => {
    expect(
      blockRoleChangeReason({
        actorId: 'admin-1',
        targetUserId: 'admin-2',
        targetCurrentRole: 'administrator',
        targetNewRole: 'counter',
        activeAdministratorCount: 2,
      }),
    ).toBeNull();
  });

  it('allows promoting a counter regardless of the administrator count', () => {
    expect(
      blockRoleChangeReason({
        actorId: 'admin-1',
        targetUserId: 'counter-1',
        targetCurrentRole: 'counter',
        targetNewRole: 'administrator',
        activeAdministratorCount: 1,
      }),
    ).toBeNull();
  });

  it('is a no-op when the role is unchanged', () => {
    expect(
      blockRoleChangeReason({
        actorId: 'admin-1',
        targetUserId: 'admin-1',
        targetCurrentRole: 'administrator',
        targetNewRole: 'administrator',
        activeAdministratorCount: 1,
      }),
    ).toBeNull();
  });
});

describe('blockDisableReason (section 27)', () => {
  it('blocks self-disable', () => {
    expect(
      blockDisableReason({
        actorId: 'admin-1',
        targetUserId: 'admin-1',
        targetRole: 'administrator',
        activeAdministratorCount: 5,
      }),
    ).not.toBeNull();
  });

  it('blocks disabling the last administrator', () => {
    expect(
      blockDisableReason({
        actorId: 'admin-1',
        targetUserId: 'admin-2',
        targetRole: 'administrator',
        activeAdministratorCount: 1,
      }),
    ).not.toBeNull();
  });

  it('allows disabling a counter', () => {
    expect(
      blockDisableReason({
        actorId: 'admin-1',
        targetUserId: 'counter-1',
        targetRole: 'counter',
        activeAdministratorCount: 1,
      }),
    ).toBeNull();
  });
});

/*
 * Single-administrator rule. The database enforces the ceiling with a partial
 * unique index (migration 0003); these cover the API-side guard that turns the
 * same rule into a 409 with an explanation instead of a constraint violation.
 */
describe('blockPromotionReason — at most one administrator', () => {
  it('blocks promoting a counter when an administrator already exists', () => {
    expect(
      blockPromotionReason({
        targetCurrentRole: 'counter',
        targetNewRole: 'administrator',
        administratorCount: 1,
      }),
    ).not.toBeNull();
  });

  it('allows the first administrator when none exists', () => {
    expect(
      blockPromotionReason({
        targetCurrentRole: 'counter',
        targetNewRole: 'administrator',
        administratorCount: 0,
      }),
    ).toBeNull();
  });

  it('ignores changes that do not target the administrator role', () => {
    expect(
      blockPromotionReason({
        targetCurrentRole: 'administrator',
        targetNewRole: 'counter',
        administratorCount: 1,
      }),
    ).toBeNull();
  });

  it('does not block re-asserting the role of the existing administrator', () => {
    // Re-inviting or re-saving the current administrator adds no second one,
    // so it must not trip the ceiling.
    expect(
      blockPromotionReason({
        targetCurrentRole: 'administrator',
        targetNewRole: 'administrator',
        administratorCount: 1,
      }),
    ).toBeNull();
  });

  it('counts administrators of every status, not just active ones', () => {
    // An invited-but-unaccepted administrator still occupies the single slot,
    // matching the partial unique index, which does not look at `status`.
    expect(
      blockPromotionReason({
        targetCurrentRole: 'counter',
        targetNewRole: 'administrator',
        administratorCount: 2,
      }),
    ).not.toBeNull();
  });
});

describe('single-administrator floor and ceiling together', () => {
  it('leaves no legal path from one administrator to two', () => {
    // Demotion of the only administrator is blocked by the floor...
    expect(
      blockRoleChangeReason({
        actorId: 'admin-1',
        targetUserId: 'admin-1',
        targetCurrentRole: 'administrator',
        targetNewRole: 'counter',
        activeAdministratorCount: 1,
      }),
    ).not.toBeNull();

    // ...and promotion of anyone else is blocked by the ceiling.
    expect(
      blockPromotionReason({
        targetCurrentRole: 'counter',
        targetNewRole: 'administrator',
        administratorCount: 1,
      }),
    ).not.toBeNull();
  });
});
