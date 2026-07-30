/**
 * Keeps the screen awake while counting — specification section 28.5
 * ("Prevent screen sleep where supported").
 *
 * Uses the Screen Wake Lock API where available and degrades silently
 * elsewhere; a locked screen mid-count is annoying, not fatal.
 */

import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
}

export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const wakeLockApi = (navigator as Navigator & WakeLockNavigator).wakeLock;
    if (wakeLockApi === undefined) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        const next = await wakeLockApi.request('screen');
        if (cancelled) {
          void next.release();
          return;
        }
        sentinel = next;
      } catch {
        // Denied (e.g. battery saver). Nothing to do.
      }
    };

    // The lock is dropped whenever the tab is hidden; re-acquire on return.
    const onVisibilityChange = (): void => {
      if (!document.hidden) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, [enabled]);
}
