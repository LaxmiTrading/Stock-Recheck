/**
 * Screen 1: Login — specification section 9.
 *
 * Invite-only: there is deliberately no Sign Up control anywhere on this page.
 * Authentication failures produce one generic message so the screen never
 * reveals whether an email is registered.
 */

import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, apiRequest, NetworkError } from '@/services/api';
import { useAuth } from './AuthContext';
import { Button, Card, Field, InlineNotice, TextInput } from '@/components/ui';
import { ClipboardCheckIcon } from '@/components/icons';

interface LocationState {
  from?: string;
}

export function LoginPage(): React.JSX.Element {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailError, setEmailError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setEmailError(undefined);
    setPasswordError(undefined);

    // Steps 1-2: validate format and presence before touching the network.
    let valid = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Enter a valid email address.');
      valid = false;
    }
    if (password.length === 0) {
      setPasswordError('Enter your password.');
      valid = false;
    }
    if (!valid) return;

    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      const destination = (location.state as LocationState | null)?.from ?? '/app/rechecks';
      navigate(destination, { replace: true });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(error.message);
      } else if (error instanceof ApiError) {
        // Step 8-9: a clear, generic message that does not disclose account
        // existence.
        setFormError(error.message);
      } else {
        setFormError('Sign in could not be completed. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--color-surface-sunken)] p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-brand-subtle)] text-[var(--color-brand)]"
          >
            <ClipboardCheckIcon size={28} />
          </span>
          <h1 className="text-2xl font-semibold">Stock Recheck</h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Physical stock verification against Zoho Books.
          </p>
        </div>

        <Card className="space-y-4">
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
            {formError !== undefined && (
              <div role="alert">
                <InlineNotice tone="danger">{formError}</InlineNotice>
              </div>
            )}

            <Field label="Email" error={emailError} required>
              {({ inputId, describedBy }) => (
                <TextInput
                  id={inputId}
                  aria-describedby={describedBy}
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoFocus
                  value={email}
                  error={emailError !== undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>

            <Field label="Password" error={passwordError} required>
              {({ inputId, describedBy }) => (
                <div className="relative">
                  <TextInput
                    id={inputId}
                    aria-describedby={describedBy}
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    error={passwordError !== undefined}
                    onChange={(event) => setPassword(event.target.value)}
                    className="pr-20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    aria-pressed={showPassword}
                    className="absolute right-2 top-1/2 min-h-[36px] -translate-y-1/2 rounded px-2 text-xs font-medium text-[var(--color-brand)]"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              )}
            </Field>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              loading={submitting}
              loadingText="Signing in…"
            >
              Sign In
            </Button>
          </form>

          <div className="border-t border-[var(--color-border)] pt-4 text-center">
            <Link
              to="/forgot-password"
              className="text-sm font-medium text-[var(--color-brand)] hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </Card>

        {/* Section 9: no Sign Up option. Registration is invite-only. */}
        <p className="mt-4 text-center text-xs text-[var(--color-ink-subtle)]">
          Accounts are created by invitation only. Contact an administrator for access.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- forgot password */

export function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await apiRequest('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
      });
      setSubmitted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold">Reset your password</h1>

        {submitted ? (
          <>
            {/* Identical response whether or not the account exists. */}
            <InlineNotice tone="success">
              If that email belongs to an account, a reset link has been sent.
            </InlineNotice>
            <Link to="/login" className="text-sm font-medium text-[var(--color-brand)]">
              Back to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
            {error !== undefined && <InlineNotice tone="danger">{error}</InlineNotice>}
            <Field
              label="Email"
              hint="We will send a reset link if this email belongs to an account."
              required
            >
              {({ inputId, describedBy }) => (
                <TextInput
                  id={inputId}
                  aria-describedby={describedBy}
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              )}
            </Field>
            <Button type="submit" variant="primary" fullWidth loading={submitting}>
              Send reset link
            </Button>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-[var(--color-brand)]"
            >
              Back to sign in
            </Link>
          </form>
        )}
      </Card>
    </div>
  );
}
