/**
 * Route guards — specification section 7
 * ("Prevent unauthorized route access on both the frontend and backend").
 *
 * These guards are a usability layer only. Every serverless function performs
 * the same authorization check independently, so bypassing the router grants
 * nothing.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { isAdministrator } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthContext';
import { Card, EmptyState, Spinner } from '@/components/ui';
import { LockIcon } from '@/components/icons';

function FullPageSpinner(): React.JSX.Element {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner size={32} label="Loading your session" />
    </div>
  );
}

export function RequireAuth(): React.JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous') {
    // Preserve the intended destination so sign-in returns the user there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

export function RequireAdministrator(): React.JSX.Element {
  const { user, status } = useAuth();

  if (status === 'loading') return <FullPageSpinner />;
  if (user === null) return <Navigate to="/login" replace />;

  if (!isAdministrator(user.role)) {
    return (
      <Card>
        <EmptyState
          icon={<LockIcon size={22} />}
          title="Administrator access required"
          message="This area is limited to administrators. If you need access, ask an administrator to change your role."
        />
      </Card>
    );
  }
  return <Outlet />;
}

/** Sends a signed-in user away from the public auth screens. */
export function RedirectIfAuthenticated({
  children,
}: {
  children: React.JSX.Element;
}): React.JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/app/rechecks" replace />;
  return children;
}
