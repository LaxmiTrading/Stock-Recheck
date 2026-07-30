/**
 * User management — specification section 27. Administrator only.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABEL, type Role } from '@/domain/permissions';
import { formatDateTime } from '@/domain/recheckNumber';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  Spinner,
  TextInput,
  useToast,
} from '@/components/ui';
import { UsersIcon } from '@/components/icons';

interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'disabled' | 'invited';
  lastLoginAt: string | null;
  createdAt: string;
  activeClaim: { itemId: string; itemName: string | null } | null;
}

export default function UsersPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user: currentUser } = useAuth();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  // Fixed: the single administrator is not created through invitations.
  const inviteRole: Role = 'counter';
  const [manualLink, setManualLink] = useState<string | null>(null);

  const [disableTarget, setDisableTarget] = useState<ManagedUser | null>(null);
  const [releaseClaim, setReleaseClaim] = useState(true);

  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => apiRequest<{ users: ManagedUser[] }>('/api/admin/users'),
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ emailDelivered: boolean; manualInviteLink: string | null }>(
        '/api/admin/users/invite',
        {
          method: 'POST',
          body: { displayName: inviteName, email: inviteEmail, role: inviteRole },
        },
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setInviteName('');
      setInviteEmail('');
      if (result.emailDelivered) {
        setInviteOpen(false);
        toast.push({ tone: 'success', title: 'Invitation sent' });
      } else {
        // No mail provider configured — hand the link to the administrator.
        setManualLink(result.manualInviteLink);
      }
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Invitation failed',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (params: { userId: string; body: Record<string, unknown> }) =>
      apiRequest(`/api/admin/users/${params.userId}`, { method: 'PATCH', body: params.body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.push({ tone: 'success', title: 'User updated' });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Update failed',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (userId: string) =>
      apiRequest(`/api/admin/users/${userId}/disable`, {
        method: 'POST',
        body: { releaseActiveClaim: releaseClaim },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setDisableTarget(null);
      toast.push({ tone: 'success', title: 'User disabled' });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not disable this user',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  if (usersQuery.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} label="Loading users" />
      </div>
    );
  }

  if (usersQuery.error !== null) {
    return (
      <ErrorState
        message={
          usersQuery.error instanceof ApiError
            ? usersQuery.error.message
            : 'Users could not be loaded.'
        }
        correlationId={
          usersQuery.error instanceof ApiError ? usersQuery.error.correlationId : undefined
        }
      />
    );
  }

  const users = usersQuery.data.users;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Registration is invite-only. There is no public sign-up, and there is exactly one
            administrator — everyone else is a counter.
          </p>
        </div>
        <Button variant="primary" onClick={() => setInviteOpen(true)}>
          Invite User
        </Button>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={<UsersIcon size={22} />} title="No users yet" message="Invite your first user to get started." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
              <tr>
                <th scope="col" className="px-3 py-2">Name</th>
                <th scope="col" className="px-3 py-2">Email</th>
                <th scope="col" className="px-3 py-2">Role</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2">Last login</th>
                <th scope="col" className="px-3 py-2">Active claim</th>
                <th scope="col" className="px-3 py-2">Created</th>
                <th scope="col" className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2 font-medium">
                    {user.name}
                    {user.id === currentUser?.id && (
                      <span className="ml-1 text-xs text-[var(--color-ink-subtle)]">(you)</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{user.email}</td>
                  {/*
                    * Read-only. There is exactly one administrator and every
                    * other account is a counter, so a role picker would offer
                    * only choices the server is guaranteed to reject.
                    */}
                  <td className="px-3 py-2">
                    <Badge tone={user.role === 'administrator' ? 'info' : 'neutral'}>
                      {ROLE_LABEL[user.role]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={
                        user.status === 'active'
                          ? 'success'
                          : user.status === 'invited'
                            ? 'warning'
                            : 'muted'
                      }
                    >
                      {user.status === 'invited' ? 'Invited' : user.status === 'active' ? 'Active' : 'Disabled'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(user.lastLoginAt)}</td>
                  <td className="px-3 py-2 text-xs">
                    {user.activeClaim === null ? '—' : user.activeClaim.itemName}
                  </td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(user.createdAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {user.status === 'disabled' ? (
                        <Button
                          size="sm"
                          onClick={() =>
                            updateMutation.mutate({ userId: user.id, body: { status: 'active' } })
                          }
                        >
                          Enable
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={user.id === currentUser?.id}
                          onClick={() => {
                            setReleaseClaim(user.activeClaim !== null);
                            setDisableTarget(user);
                          }}
                        >
                          Disable
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ---------------------------------------------------- invite dialog */}
      <Dialog
        open={inviteOpen}
        title="Invite a user"
        onClose={() => {
          setInviteOpen(false);
          setManualLink(null);
        }}
        footer={
          manualLink !== null ? (
            <Button
              variant="primary"
              onClick={() => {
                setInviteOpen(false);
                setManualLink(null);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={inviteMutation.isPending}
                disabled={inviteName.trim() === '' || inviteEmail.trim() === ''}
                onClick={() => inviteMutation.mutate()}
              >
                Send invitation
              </Button>
            </>
          )
        }
      >
        {manualLink !== null ? (
          <div className="space-y-3">
            <InlineNotice tone="warning">
              No email provider is configured, so the invitation was not sent automatically. Give
              this single-use link to the invited person through a channel you trust.
            </InlineNotice>
            <TextInput readOnly value={manualLink} className="font-mono text-xs" />
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(manualLink);
                toast.push({ tone: 'success', title: 'Link copied' });
              }}
            >
              Copy link
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Name" required>
              {({ inputId }) => (
                <TextInput
                  id={inputId}
                  value={inviteName}
                  onChange={(event) => setInviteName(event.target.value)}
                />
              )}
            </Field>
            <Field label="Email" required>
              {({ inputId }) => (
                <TextInput
                  id={inputId}
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              )}
            </Field>
            <InlineNotice tone="info">
              Invited users join as <strong>counters</strong>. This application has a single
              administrator account, which cannot be transferred from here.
            </InlineNotice>
          </div>
        )}
      </Dialog>

      {/* --------------------------------------------------- disable dialog */}
      <Dialog
        open={disableTarget !== null}
        tone="danger"
        title="Disable this user?"
        description={
          disableTarget === null ? undefined : (
            <>
              <strong>{disableTarget.name}</strong> will no longer be able to sign in.
              {disableTarget.activeClaim !== null && (
                <>
                  {' '}
                  They currently hold an active claim on{' '}
                  <strong>{disableTarget.activeClaim.itemName}</strong>.
                </>
              )}
            </>
          )
        }
        onClose={() => setDisableTarget(null)}
        footer={
          <>
            <Button onClick={() => setDisableTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={disableMutation.isPending}
              onClick={() => {
                if (disableTarget !== null) disableMutation.mutate(disableTarget.id);
              }}
            >
              Disable user
            </Button>
          </>
        }
      >
        {disableTarget?.activeClaim !== null && disableTarget !== null && (
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 accent-[var(--color-brand)]"
              checked={releaseClaim}
              onChange={(event) => setReleaseClaim(event.target.checked)}
            />
            Release their active claim so another user can count the item.
          </label>
        )}
      </Dialog>

    </div>
  );
}
