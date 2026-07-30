/**
 * Settings → Claim Rules — specification section 28.4.
 * Validates that the heartbeat is meaningfully shorter than the lease.
 */

import { useEffect, useState } from 'react';
import { heartbeatValidationMessage } from '@/domain/claims';
import type { AppSettings } from '@/domain/settings';
import { Button, Card, Checkbox, Field, InlineNotice, Spinner, TextInput } from '@/components/ui';
import { useSettingsMutation, useSettingsQuery } from './useSettingsForm';

export default function ClaimRulesSettings(): React.JSX.Element {
  const { data, isPending } = useSettingsQuery();
  const save = useSettingsMutation();
  const [form, setForm] = useState<Partial<AppSettings>>({});

  useEffect(() => {
    if (data !== undefined) setForm(data.settings);
  }, [data]);

  if (isPending || data === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={28} label="Loading settings" />
      </div>
    );
  }

  const lease = form.claimLeaseSeconds ?? 900;
  const heartbeat = form.heartbeatSeconds ?? 30;
  const heartbeatIssue = heartbeatValidationMessage(heartbeat, lease);

  const set = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (heartbeatIssue !== null) return;
        save.mutate(form);
      }}
    >
      <InlineNotice tone="info">
        A claim gives one user exclusive counting rights on an item. The lease expires unless the
        counting screen keeps sending heartbeats, so a closed laptop cannot block an item forever.
      </InlineNotice>

      <Card className="grid gap-4 md:grid-cols-2">
        <Field
          label="Claim lease duration (seconds)"
          hint="How long a claim survives without a heartbeat. Default 900 (15 minutes)."
        >
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              type="number"
              min={60}
              max={86400}
              value={lease}
              onChange={(event) => set('claimLeaseSeconds', Number(event.target.value))}
            />
          )}
        </Field>

        <Field
          label="Heartbeat interval (seconds)"
          hint="How often the counting screen extends the lease. Default 30."
          error={heartbeatIssue ?? undefined}
        >
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              type="number"
              min={5}
              max={3600}
              error={heartbeatIssue !== null}
              value={heartbeat}
              onChange={(event) => set('heartbeatSeconds', Number(event.target.value))}
            />
          )}
        </Field>

        <Field
          label="Stale-claim grace period (seconds)"
          hint="Extra time after expiry before another user may reclaim the item."
        >
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              max={3600}
              value={form.staleClaimGraceSeconds ?? 60}
              onChange={(event) => set('staleClaimGraceSeconds', Number(event.target.value))}
            />
          )}
        </Field>
      </Card>

      <Card className="space-y-3">
        <Checkbox
          checked={form.countersMayReleaseOwnClaims ?? true}
          onChange={(event) => set('countersMayReleaseOwnClaims', event.target.checked)}
          label="Counters may release their own claims"
          description="When off, only an administrator can return a claimed item to Available."
        />
        <Checkbox
          checked={form.adminsMayForceRelease ?? true}
          onChange={(event) => set('adminsMayForceRelease', event.target.checked)}
          label="Administrators may force-release another user's claim"
          description="A force-release always requires a written reason and is recorded in the audit log."
        />
      </Card>

      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={heartbeatIssue !== null}
          loading={save.isPending}
          loadingText="Saving…"
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}
