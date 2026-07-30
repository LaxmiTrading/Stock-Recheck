/** Debounces a rapidly changing value — specification section 19 (search). */

import { useEffect, useState } from 'react';

export function useDebouncedValue<Value>(value: Value, delayMs = 300): Value {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
