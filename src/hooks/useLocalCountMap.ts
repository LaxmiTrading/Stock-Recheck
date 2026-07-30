/**
 * Local counts for a MULTI-ITEM counting session — sections 2.3 and 22.
 *
 * ================== THE COUNT IS LOCAL UNTIL SUBMISSION ===================
 * Like `useLocalCount`, this never calls the server. The database learns each
 * number exactly once, when the operator submits.
 * =========================================================================
 *
 * It deliberately reuses `localCountKey` — one localStorage entry per item,
 * the same key and the same payload as the single-item screen. A session-shaped
 * key would have been simpler here but would fork the storage format, so a
 * draft started on one screen would be invisible to the other and a
 * half-counted item could silently reset when the operator switched views.
 *
 * Drafts are only adopted when their `claimVersion` still matches the live
 * claim (section 22): a count entered under a previous claim belongs to
 * whoever held that claim, not to the current holder.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { localCountKey, type LocalCountDraft } from './useLocalCount';

export interface SessionItemKey {
  itemId: string;
  normalizedSku: string;
  claimVersion: number;
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

export interface UseLocalCountMapResult {
  counts: ReadonlyMap<string, number>;
  countOf: (itemId: string) => number;
  /** Adds `delta`, floored at zero. Returns the new value. */
  adjust: (item: SessionItemKey, delta: number) => number;
  /** Sets an absolute value; anything unparseable or negative becomes 0. */
  setCount: (item: SessionItemKey, value: number | string) => number;
  /** Removes the draft for one item (after submission or release). */
  discard: (itemId: string) => void;
  /** Removes every draft in the session. */
  discardAll: () => void;
  /** How many drafts were restored from storage at mount. */
  restoredCount: number;
}

export function useLocalCountMap(params: {
  userId: string;
  recheckId: string;
  items: readonly SessionItemKey[];
  enabled: boolean;
}): UseLocalCountMapResult {
  const { userId, recheckId, items, enabled } = params;

  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());

  /*
   * A mirror that is always current. A barcode scanner fires keystrokes far
   * faster than React re-renders, so a burst of scans on the same SKU read a
   * stale `counts` and would each write the same value — losing every scan but
   * the last. Reading and writing through the ref makes each scan see its
   * predecessor's result.
   */
  const countsRef = useRef<Map<string, number>>(new Map());
  const [restoredCount, setRestoredCount] = useState(0);

  /* Which items have already been hydrated, so adding a row to the session
     later does not re-read (and re-adopt) the rows already being counted. */
  const hydrated = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;

    let restored = 0;
    let changed = false;
    const next = new Map(countsRef.current);

    for (const item of items) {
      if (hydrated.current.has(item.itemId)) continue;
      hydrated.current.add(item.itemId);

      const draft = readDraft(localCountKey({ userId, recheckId, itemId: item.itemId }));
      if (draft === null) continue;

      // Section 22: a draft from an earlier claim generation is not ours.
      if (draft.claimVersion !== item.claimVersion) continue;
      if (draft.count === 0) continue;

      next.set(item.itemId, draft.count);
      restored += 1;
      changed = true;
    }

    if (!changed) return;
    countsRef.current = next;
    setCounts(next);
    setRestoredCount((current) => current + restored);
  }, [enabled, items, recheckId, userId]);

  const persist = useCallback(
    (item: SessionItemKey, value: number) => {
      if (!enabled) return;
      const draft: LocalCountDraft = {
        count: value,
        updatedAt: new Date().toISOString(),
        claimVersion: item.claimVersion,
        itemId: item.itemId,
        normalizedSku: item.normalizedSku,
        userId,
      };
      try {
        localStorage.setItem(localCountKey({ userId, recheckId, itemId: item.itemId }), JSON.stringify(draft));
      } catch {
        // Storage full or blocked: the in-memory count still works, the
        // operator just loses refresh protection.
      }
    },
    [enabled, recheckId, userId],
  );

  const commit = useCallback(
    (item: SessionItemKey, value: number): number => {
      const next = new Map(countsRef.current);
      next.set(item.itemId, value);
      countsRef.current = next;
      setCounts(next);
      persist(item, value);
      return value;
    },
    [persist],
  );

  const adjust = useCallback(
    (item: SessionItemKey, delta: number): number =>
      commit(item, Math.max(0, (countsRef.current.get(item.itemId) ?? 0) + delta)),
    [commit],
  );

  const setCount = useCallback(
    (item: SessionItemKey, value: number | string): number => {
      const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
      const safe = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      return commit(item, safe);
    },
    [commit],
  );

  const discard = useCallback(
    (itemId: string): void => {
      const next = new Map(countsRef.current);
      next.delete(itemId);
      countsRef.current = next;
      setCounts(next);
      hydrated.current.delete(itemId);
      try {
        localStorage.removeItem(localCountKey({ userId, recheckId, itemId }));
      } catch {
        /* ignore */
      }
    },
    [recheckId, userId],
  );

  const discardAll = useCallback((): void => {
    for (const itemId of countsRef.current.keys()) {
      try {
        localStorage.removeItem(localCountKey({ userId, recheckId, itemId }));
      } catch {
        /* ignore */
      }
    }
    countsRef.current = new Map();
    setCounts(new Map());
    hydrated.current.clear();
  }, [recheckId, userId]);

  const countOf = useCallback((itemId: string): number => counts.get(itemId) ?? 0, [counts]);

  return { counts, countOf, adjust, setCount, discard, discardAll, restoredCount };
}
