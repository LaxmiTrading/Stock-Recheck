/**
 * Local counted quantity — specification sections 2.3 and 22.
 *
 * ================== THE COUNT IS LOCAL UNTIL SUBMISSION ===================
 * This hook is the ONLY place the working count lives. It never calls the
 * server. The central database learns the number exactly once, when the user
 * confirms "Submit Final Count" (section 2.3).
 *
 * The value is mirrored into localStorage so an accidental refresh does not
 * destroy a partially finished count, keyed by environment + user + recheck +
 * item so two users on a shared device can never see each other's drafts.
 * =========================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LocalCountDraft {
  /** The working count. */
  count: number;
  /** ISO timestamp of the last change. */
  updatedAt: string;
  /** Claim generation this draft belongs to — section 22. */
  claimVersion: number;
  itemId: string;
  normalizedSku: string;
  userId: string;
}

/** `stock-recheck:{environment}:{userId}:{recheckId}:{itemId}` — section 22. */
export function localCountKey(params: {
  userId: string;
  recheckId: string;
  itemId: string;
}): string {
  const environment = import.meta.env.MODE ?? 'development';
  return `stock-recheck:${environment}:${params.userId}:${params.recheckId}:${params.itemId}`;
}

function readDraft(key: string): LocalCountDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<LocalCountDraft>;
    if (typeof parsed.count !== 'number' || !Number.isInteger(parsed.count) || parsed.count < 0) {
      return null;
    }
    return parsed as LocalCountDraft;
  } catch {
    return null;
  }
}

export interface UseLocalCountResult {
  count: number;
  /** The draft found in storage at mount, before any validation. */
  storedDraft: LocalCountDraft | null;
  increment: () => number;
  decrement: () => number;
  reset: () => void;
  /** Adopts a validated stored value. */
  restore: (count: number) => void;
  /** Removes the draft entirely (after submission or release). */
  discard: () => void;
}

export function useLocalCount(params: {
  userId: string;
  recheckId: string;
  itemId: string;
  claimVersion: number;
  normalizedSku: string;
  /** Skip storage entirely, e.g. before the claim is confirmed. */
  enabled: boolean;
}): UseLocalCountResult {
  const key = localCountKey(params);
  const [count, setCount] = useState(0);
  const [storedDraft, setStoredDraft] = useState<LocalCountDraft | null>(null);
  const hasLoaded = useRef(false);

  // Read the persisted draft once. It is NOT applied automatically: the
  // counting screen must first verify claim ownership with the server
  // (section 22).
  useEffect(() => {
    if (!params.enabled || hasLoaded.current) return;
    hasLoaded.current = true;
    setStoredDraft(readDraft(key));
  }, [key, params.enabled]);

  const persist = useCallback(
    (nextCount: number) => {
      if (!params.enabled) return;
      const draft: LocalCountDraft = {
        count: nextCount,
        updatedAt: new Date().toISOString(),
        claimVersion: params.claimVersion,
        itemId: params.itemId,
        normalizedSku: params.normalizedSku,
        userId: params.userId,
      };
      try {
        localStorage.setItem(key, JSON.stringify(draft));
      } catch {
        // Storage full or blocked: the in-memory count still works, the user
        // just loses refresh protection.
      }
    },
    [key, params.claimVersion, params.enabled, params.itemId, params.normalizedSku, params.userId],
  );

  const increment = useCallback((): number => {
    let next = 0;
    setCount((current) => {
      next = current + 1;
      persist(next);
      return next;
    });
    return next;
  }, [persist]);

  /** Undo Last Scan — simply reduces the quantity by one (section 21). */
  const decrement = useCallback((): number => {
    let next = 0;
    setCount((current) => {
      next = Math.max(0, current - 1);
      persist(next);
      return next;
    });
    return next;
  }, [persist]);

  const reset = useCallback((): void => {
    setCount(0);
    persist(0);
  }, [persist]);

  const restore = useCallback(
    (restored: number): void => {
      setCount(restored);
      persist(restored);
    },
    [persist],
  );

  const discard = useCallback((): void => {
    setCount(0);
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }, [key]);

  return { count, storedDraft, increment, decrement, reset, restore, discard };
}
