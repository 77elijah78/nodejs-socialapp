import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { Button, Card, EmptyState, LoadingState, PageHeader, TextArea } from '../components/ui';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['platform-settings'],
    queryFn: async () => (await apiRequest<any[]>('/admin/settings')).data,
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const updateMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => apiRequest('/admin/settings', { method: 'PUT', body: { key, value } }),
    onSuccess: () => {
      toast.success('Setting updated');
      void queryClient.invalidateQueries({ queryKey: ['platform-settings'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update setting'),
  });

  if (settingsQuery.isLoading) return <LoadingState label="Loading settings…" />;
  if (settingsQuery.isError) return <EmptyState title="Unable to load settings" description={(settingsQuery.error as Error).message} />;

  return (
    <div className="page-shell">
      <PageHeader title="Platform settings" subtitle="Safe application-level configuration only. Secrets and infrastructure credentials are never exposed here." />
      <div className="settings-grid">
        {settingsQuery.data!.map((setting: any) => {
          const currentValue = drafts[setting.key] ?? JSON.stringify(setting.value, null, 2);
          return (
            <Card key={setting.id}>
              <div className="stack-list compact">
                <div>
                  <h3>{setting.key}</h3>
                  <div className="muted small">{setting.category}</div>
                </div>
                <p className="muted">{setting.description || 'No description available'}</p>
                <TextArea rows={6} value={currentValue} onChange={(event) => setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))} />
                <Button kind="secondary" onClick={() => {
                  try {
                    const parsed = JSON.parse(currentValue);
                    updateMutation.mutate({ key: setting.key, value: parsed });
                  } catch {
                    toast.error('Value must be valid JSON');
                  }
                }}>Save setting</Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
