/**
 * Application providers: server-state, authentication and toasts.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import clsx from 'clsx';
import { AuthProvider } from '@/features/auth/AuthContext';
import { ApiError } from '@/services/api';
import { ToastContext, TONE_BG, ToneIcon, type ToastMessage } from '@/components/ui';
import { CloseIcon } from '@/components/icons';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * Data refreshes when a screen is opened, not on a timer.
         *
         * `refetchOnMount: 'always'` ignores staleTime for the mount refetch, so
         * navigating to a screen — or reloading the tab — always shows current
         * server state. Nothing polls in the background any more.
         *
         * A stale list is safe here because every state change is enforced
         * server-side: claiming an item another user already took returns a
         * clean 409 rather than corrupting anything (sections 2.4 and 20).
         */
        refetchOnMount: 'always',
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // Never retry a rejection the user must act on (auth, validation,
          // conflict) — only transient infrastructure failures.
          if (error instanceof ApiError) return error.isRetryable && failureCount < 2;
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: { retry: false },
    },
  });
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  return (
    <div
      // Section 36: announced without stealing focus.
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:bottom-auto sm:right-0 sm:top-0 sm:items-end"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx(
            'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border border-[var(--color-border)] p-3 shadow-lg',
            TONE_BG[toast.tone],
          )}
        >
          <ToneIcon tone={toast.tone} size={16} className="mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold">{toast.title}</p>
            {toast.description !== undefined && (
              <p className="mt-0.5 text-xs opacity-90">{toast.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            className="min-h-[24px] px-1 opacity-70 hover:opacity-100"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AppProviders({ children }: { children: ReactNode }): React.JSX.Element {
  const [queryClient] = useState(createQueryClient);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<ToastMessage, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { ...toast, id }]);
      // Errors linger; confirmations clear themselves.
      const lifetime = toast.tone === 'danger' ? 9000 : 4500;
      setTimeout(() => dismiss(id), lifetime);
    },
    [dismiss],
  );

  const toastValue = useMemo(() => ({ push }), [push]);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastContext.Provider value={toastValue}>
        <AuthProvider>
          {children}
          <ToastViewport toasts={toasts} onDismiss={dismiss} />
        </AuthProvider>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}
