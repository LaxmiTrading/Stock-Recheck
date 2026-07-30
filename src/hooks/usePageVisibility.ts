/**
 * Tracks tab visibility so polling can pause when hidden — specification
 * section 33 ("Pause or reduce polling when the tab is hidden").
 */

import { useEffect, useState } from 'react';

export function usePageVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(
    typeof document === 'undefined' ? true : !document.hidden,
  );

  useEffect(() => {
    const onChange = (): void => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return isVisible;
}
