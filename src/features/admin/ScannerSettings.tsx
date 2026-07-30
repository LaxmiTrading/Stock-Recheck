/**
 * Settings → Scanner — specification section 28.5.
 */

import { useEffect, useState } from 'react';
import type { AppSettings } from '@/domain/settings';
import { Button, Card, Checkbox, InlineNotice, Spinner } from '@/components/ui';
import { useSettingsMutation, useSettingsQuery } from './useSettingsForm';

export default function ScannerSettings(): React.JSX.Element {
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

  const set = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(form);
      }}
    >
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">Feedback</h3>
        <Checkbox
          checked={form.scannerSuccessSound ?? true}
          onChange={(event) => set('scannerSuccessSound', event.target.checked)}
          label="Success sound"
        />
        <Checkbox
          checked={form.scannerErrorSound ?? true}
          onChange={(event) => set('scannerErrorSound', event.target.checked)}
          label="Error sound"
        />
        <Checkbox
          checked={form.scannerSuccessFlash ?? true}
          onChange={(event) => set('scannerSuccessFlash', event.target.checked)}
          label="Success visual flash"
        />
        <Checkbox
          checked={form.scannerErrorFlash ?? true}
          onChange={(event) => set('scannerErrorFlash', event.target.checked)}
          label="Error visual flash"
        />
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">Behaviour</h3>
        <Checkbox
          checked={form.scannerRequireEnter ?? true}
          onChange={(event) => set('scannerRequireEnter', event.target.checked)}
          label="Require Enter after scan"
          description="Hardware scanners normally send Enter automatically."
        />
        <Checkbox
          checked={form.scannerAutoSelectInvalid ?? true}
          onChange={(event) => set('scannerAutoSelectInvalid', event.target.checked)}
          label="Auto-select invalid scan text"
          description="Keeps the bad value visible but selected, so the next scan replaces it in one action."
        />
        <Checkbox
          checked={form.scannerPreventSleep ?? true}
          onChange={(event) => set('scannerPreventSleep', event.target.checked)}
          label="Prevent screen sleep while counting"
          description="Where the browser supports the Screen Wake Lock API."
        />
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">Blind count</h3>
        <Checkbox
          checked={form.blindCountEnabled ?? false}
          onChange={(event) => set('blindCountEnabled', event.target.checked)}
          label="Hide Zoho quantity while counting"
          description="Counters do not see the expected quantity until the item is submitted. Off by default."
        />
        {form.blindCountEnabled === true && (
          <InlineNotice tone="info">
            The workspace and administrator reports still show the Zoho quantity according to role
            permissions.
          </InlineNotice>
        )}
      </Card>

      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending} loadingText="Saving…">
          Save changes
        </Button>
      </div>
    </form>
  );
}
