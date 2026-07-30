/**
 * Navigation guard for an unsubmitted local count — specification section 38.
 *
 * Warns on browser close/refresh via `beforeunload`. In-app navigation is
 * intercepted by the counting screen itself, which shows the three documented
 * options (Stay / Leave and Keep Claim / Release Item and Discard Count).
 */

import { useEffect } from 'react';

export function useUnsavedCountGuard(hasUnsavedCount: boolean): void {
  useEffect(() => {
    if (!hasUnsavedCount) return;

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // Browsers show their own generic wording; setting returnValue is what
      // triggers the prompt at all.
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedCount]);
}
