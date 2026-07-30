/**
 * Profile screen — /app/profile from the section 7 route traversal.
 * Lets any signed-in user see their identity and change their own password.
 */

import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ROLE_LABEL } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest } from '@/services/api';
import { Badge, Button, Card, Field, InlineNotice, TextInput, useToast } from '@/components/ui';

const MIN_PASSWORD_LENGTH = 12;

export default function ProfilePage(): React.JSX.Element {
  const { user, settings, signOut } = useAuth();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();

  const changePassword = useMutation({
    mutationFn: () =>
      apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setError(undefined);
      toast.push({ tone: 'success', title: 'Password changed' });
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.message : 'The password could not be changed.');
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(undefined);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmation) {
      setError('The two new passwords do not match.');
      return;
    }
    changePassword.mutate();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Profile</h2>
        <p className="text-sm text-[var(--color-ink-muted)]">Your account and sign-in settings.</p>
      </div>

      <Card>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Name</dt>
            <dd className="font-medium">{user?.displayName}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Email</dt>
            <dd>{user?.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Role</dt>
            <dd>
              <Badge tone={user?.role === 'administrator' ? 'info' : 'neutral'}>
                {user === null ? '—' : ROLE_LABEL[user.role]}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Business timezone</dt>
            <dd>{settings?.businessTimezone ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h3 className="mb-3 text-base font-semibold">Change password</h3>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error !== undefined && <InlineNotice tone="danger">{error}</InlineNotice>}

          <Field label="Current password" required>
            {({ inputId }) => (
              <TextInput
                id={inputId}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="New password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters, mixing letters, digits and symbols.`}
            required
          >
            {({ inputId, describedBy }) => (
              <TextInput
                id={inputId}
                aria-describedby={describedBy}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            )}
          </Field>

          <Field label="Confirm new password" required>
            {({ inputId }) => (
              <TextInput
                id={inputId}
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            )}
          </Field>

          <Button
            type="submit"
            variant="primary"
            loading={changePassword.isPending}
            loadingText="Saving…"
          >
            Change password
          </Button>
        </form>
      </Card>

      <Card>
        <h3 className="mb-2 text-base font-semibold">Session</h3>
        <p className="mb-3 text-sm text-[var(--color-ink-muted)]">
          Signing out clears your session on this device. Any unsubmitted local count stays on the
          device but cannot be submitted until you sign in again and still hold the claim.
        </p>
        <Button variant="danger" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}
