/**
 * Invitation acceptance and password reset — specification section 4.5.
 *
 * Both flows collect a new password against a single-use token from the link.
 * The same component serves both, discriminated by `mode`.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, apiRequest } from '@/services/api';
import { useAuth } from './AuthContext';
import { Button, Card, Field, InlineNotice, TextInput } from '@/components/ui';

const MIN_PASSWORD_LENGTH = 12;

/** Mirrors the server-side rule in netlify/shared/auth/password.ts. */
function passwordIssue(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (classes < 3) return 'Use at least three of: lowercase, uppercase, digits, symbols.';
  return null;
}

export function SetPasswordPage({ mode }: { mode: 'invite' | 'reset' }): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const isInvite = mode === 'invite';

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setFieldError(undefined);

    const issue = passwordIssue(password);
    if (issue !== null) {
      setFieldError(issue);
      return;
    }
    if (password !== confirmation) {
      setFieldError('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest(isInvite ? '/api/auth/accept-invite' : '/api/auth/reset-password', {
        method: 'POST',
        body: { token, password },
      });

      if (isInvite) {
        // Accepting an invite signs the user in immediately.
        await refresh();
        navigate('/app/rechecks', { replace: true });
      } else {
        setDone(true);
      }
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'This could not be completed. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (token === '') {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-md space-y-4">
          <h1 className="text-xl font-semibold">Link is incomplete</h1>
          <InlineNotice tone="danger">
            This link is missing its token. Ask an administrator to send a new one.
          </InlineNotice>
          <Link to="/login" className="text-sm font-medium text-[var(--color-brand)]">
            Back to sign in
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold">
          {isInvite ? 'Activate your account' : 'Choose a new password'}
        </h1>

        {done ? (
          <>
            <InlineNotice tone="success">
              Your password has been changed. Sign in with your new password.
            </InlineNotice>
            <Button variant="primary" fullWidth onClick={() => navigate('/login')}>
              Go to sign in
            </Button>
          </>
        ) : (
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
            {formError !== undefined && <InlineNotice tone="danger">{formError}</InlineNotice>}

            <Field
              label="New password"
              hint={`At least ${MIN_PASSWORD_LENGTH} characters, mixing letters, digits and symbols.`}
              error={fieldError}
              required
            >
              {({ inputId, describedBy }) => (
                <TextInput
                  id={inputId}
                  aria-describedby={describedBy}
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  error={fieldError !== undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>

            <Field label="Confirm password" required>
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

            <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
              {isInvite ? 'Activate account' : 'Change password'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
