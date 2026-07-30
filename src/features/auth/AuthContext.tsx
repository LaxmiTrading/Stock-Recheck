/**
 * Authentication context — specification sections 4.5, 9, 38.
 *
 * The session itself is an httpOnly cookie, so this context holds only the
 * decoded profile and the operational settings a signed-in user needs. When
 * the server reports an expired session the context clears itself and the
 * router sends the user to /login WITHOUT discarding any local count
 * (section 38).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Role } from '@/domain/permissions';
import { apiRequest, onSessionExpired } from '@/services/api';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

/** Operational settings exposed to any signed-in user (never integration detail). */
export interface SessionSettings {
  businessName: string;
  businessTimezone: string;
  dateFormat: string;
  skuCaseSensitive: boolean;
  claimLeaseSeconds: number;
  heartbeatSeconds: number;
  blindCountEnabled: boolean;
  scannerSoundEnabled: boolean;
  scannerSuccessSound: boolean;
  scannerErrorSound: boolean;
  scannerSuccessFlash: boolean;
  scannerErrorFlash: boolean;
  scannerRequireEnter: boolean;
  scannerAutoSelectInvalid: boolean;
  scannerPreventSleep: boolean;
  countersMayReleaseOwnClaims: boolean;
  defaultSort: string;
}

export interface ActiveClaim {
  itemId: string;
  recheckId: string;
  recheckNumber: string;
  itemName: string;
  sku: string;
  claimExpiresAt: string;
}

interface MeResponse {
  user: SessionUser;
  settings: SessionSettings;
  activeClaim: ActiveClaim | null;
}

interface AuthContextValue {
  user: SessionUser | null;
  settings: SessionSettings | null;
  activeClaim: ActiveClaim | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [activeClaim, setActiveClaim] = useState<ActiveClaim | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const queryClient = useQueryClient();

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<MeResponse>('/api/me');
      setUser(data.user);
      setSettings(data.settings);
      setActiveClaim(data.activeClaim);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setSettings(null);
      setActiveClaim(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A 401/expired response anywhere in the app clears the session here.
  useEffect(
    () =>
      onSessionExpired(() => {
        setUser(null);
        setSettings(null);
        setActiveClaim(null);
        setStatus('anonymous');
      }),
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      await apiRequest<{ user: SessionUser }>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      await load();
    },
    [load],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setSettings(null);
      setActiveClaim(null);
      setStatus('anonymous');
      // Drop every cached server response so a second user on a shared device
      // cannot see the previous user's data.
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, settings, activeClaim, status, signIn, signOut, refresh: load }),
    [user, settings, activeClaim, status, signIn, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Convenience for screens that are only rendered behind a guard. */
export function useCurrentUser(): SessionUser {
  const { user } = useAuth();
  if (user === null) throw new Error('useCurrentUser used outside an authenticated route');
  return user;
}

export function useSettings(): SessionSettings {
  const { settings } = useAuth();
  if (settings === null) throw new Error('useSettings used outside an authenticated route');
  return settings;
}
