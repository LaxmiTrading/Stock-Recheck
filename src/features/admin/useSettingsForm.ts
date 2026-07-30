/**
 * Shared settings load/save behaviour for the five settings tabs —
 * specification section 28.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@/domain/settings';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest } from '@/services/api';
import { useToast } from '@/components/ui';

export function useSettingsQuery() {
  return useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => apiRequest<{ settings: AppSettings }>('/api/admin/settings'),
  });
}

export function useSettingsMutation() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();

  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) =>
      apiRequest<{ settings: AppSettings; note: string | null }>('/api/admin/settings', {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      // Several settings (scanner, blind count, claim rules) are mirrored in
      // the session payload, so refresh it too.
      await refresh();
      toast.push({
        tone: 'success',
        title: 'Settings saved',
        description: result.note ?? undefined,
      });
    },
    onError: (error) => {
      const issues =
        error instanceof ApiError && Array.isArray(error.details.issues)
          ? (error.details.issues as { path: string; message: string }[])
          : [];
      toast.push({
        tone: 'danger',
        title: 'Settings could not be saved',
        description:
          issues.length > 0
            ? issues.map((issue) => issue.message).join(' ')
            : error instanceof ApiError
              ? error.message
              : 'Try again.',
      });
    },
  });
}
