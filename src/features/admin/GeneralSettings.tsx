/**
 * Settings → General — specification section 28.1.
 */

import { useEffect, useState } from 'react';
import { SORT_KEY_LABEL, SORT_KEYS, type AppSettings, type SortKey } from '@/domain/settings';
import { Button, Card, Checkbox, Field, Select, Spinner, TextInput } from '@/components/ui';
import { useSettingsMutation, useSettingsQuery } from './useSettingsForm';

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

export default function GeneralSettings(): React.JSX.Element {
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
      <Card className="grid gap-4 md:grid-cols-2">
        <Field label="Business name">
          {({ inputId }) => (
            <TextInput
              id={inputId}
              value={form.businessName ?? ''}
              onChange={(event) => set('businessName', event.target.value)}
            />
          )}
        </Field>

        <Field label="Business timezone" hint="Used for business dates and the daily sequence.">
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={form.businessTimezone ?? 'Asia/Kolkata'}
              onChange={(event) => set('businessTimezone', event.target.value)}
            >
              {TIMEZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Date format">
          {({ inputId }) => (
            <TextInput
              id={inputId}
              value={form.dateFormat ?? ''}
              onChange={(event) => set('dateFormat', event.target.value)}
            />
          )}
        </Field>

        <Field label="Recheck-number prefix" hint="Letters and digits only, e.g. SR.">
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              maxLength={10}
              value={form.recheckPrefix ?? ''}
              onChange={(event) => set('recheckPrefix', event.target.value.toUpperCase())}
            />
          )}
        </Field>

        <Field label="Maximum import rows">
          {({ inputId }) => (
            <TextInput
              id={inputId}
              type="number"
              min={1}
              max={100000}
              value={form.maxImportRows ?? 20000}
              onChange={(event) => set('maxImportRows', Number(event.target.value))}
            />
          )}
        </Field>

        <Field label="Maximum Excel file size (MB)">
          {({ inputId }) => (
            <TextInput
              id={inputId}
              type="number"
              min={1}
              max={50}
              value={Math.round((form.maxFileSizeBytes ?? 10485760) / (1024 * 1024))}
              onChange={(event) =>
                set('maxFileSizeBytes', Math.max(1, Number(event.target.value)) * 1024 * 1024)
              }
            />
          )}
        </Field>

        <Field label="Default sort">
          {({ inputId }) => (
            <Select
              id={inputId}
              value={form.defaultSort ?? 'item_name'}
              onChange={(event) => set('defaultSort', event.target.value as SortKey)}
            >
              {SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SORT_KEY_LABEL[key]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Card>

      <Card className="space-y-3">
        <Checkbox
          checked={form.skuCaseSensitive ?? false}
          onChange={(event) => set('skuCaseSensitive', event.target.checked)}
          label="Case-sensitive SKU matching"
          description="Off by default: AB-001 and ab-001 are treated as the same SKU. Changing this affects future imports and scanning."
        />
        <Checkbox
          checked={form.scannerSoundEnabled ?? true}
          onChange={(event) => set('scannerSoundEnabled', event.target.checked)}
          label="Sound enabled by default"
          description="Counters can still be affected by their device's mute switch."
        />
      </Card>

      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending} loadingText="Saving…">
          Save changes
        </Button>
      </div>
    </form>
  );
}
