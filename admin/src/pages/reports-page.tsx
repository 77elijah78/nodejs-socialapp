import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, LoadingState, PageHeader, Select, Table, TextArea } from '../components/ui';

export function ReportsPage() {
  const { session } = useAuth();
  const [status, setStatus] = useState('');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const reportsQuery = useQuery({
    queryKey: ['admin-reports', status],
    queryFn: async () => apiRequest<any[]>('/admin/reports', { query: { status } }),
  });

  const canManageAdmins = session?.adminAccount.permissions.includes('manage:admins');

  const adminsQuery = useQuery({
    queryKey: ['admin-accounts-options'],
    enabled: Boolean(canManageAdmins),
    queryFn: async () => apiRequest<any[]>('/admin/admins'),
  });

  const reportDetailQuery = useQuery({
    queryKey: ['admin-report-detail', selectedReportId],
    enabled: Boolean(selectedReportId),
    queryFn: async () => (await apiRequest<any>(`/admin/reports/${selectedReportId}`)).data,
  });

  const noteMutation = useMutation({
    mutationFn: async () => {
      if (!selectedReportId) throw new Error('Select a report first');
      return apiRequest(`/admin/reports/${selectedReportId}/notes`, { method: 'POST', body: { note } });
    },
    onSuccess: () => {
      setNote('');
      toast.success('Note added');
      void queryClient.invalidateQueries({ queryKey: ['admin-report-detail', selectedReportId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to add note'),
  });

  const updateStatusMutation = useMutation({
    mutationFn: async (payload: { status: string; removePost?: boolean; suspendUser?: boolean; banUser?: boolean }) => {
      if (!selectedReportId) throw new Error('Select a report first');
      const reason = window.prompt('Resolution reason / note');
      return apiRequest(`/admin/reports/${selectedReportId}/status`, { method: 'POST', body: { ...payload, reason, note: reason } });
    },
    onSuccess: () => {
      toast.success('Report updated');
      void queryClient.invalidateQueries({ queryKey: ['admin-reports'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-report-detail', selectedReportId] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update report'),
  });

  const assignMutation = useMutation({
    mutationFn: async (adminAccountId: string) => {
      if (!selectedReportId) throw new Error('Select a report first');
      return apiRequest(`/admin/reports/${selectedReportId}/assign`, { method: 'POST', body: { adminAccountId, reason: 'Manual assignment from admin panel' } });
    },
    onSuccess: () => {
      toast.success('Report assigned');
      void queryClient.invalidateQueries({ queryKey: ['admin-reports'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-report-detail', selectedReportId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to assign report'),
  });

  if (reportsQuery.isLoading) return <LoadingState label="Loading reports…" />;
  if (reportsQuery.isError) return <EmptyState title="Unable to load reports" description={(reportsQuery.error as Error).message} />;

  return (
    <div className="page-shell">
      <PageHeader title="Reports & moderation" subtitle="Operational queue for reported content with assignment, internal notes, and audited resolution actions." />

      <div className="card-grid two-up">
        <Card>
          <div className="toolbar">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="REVIEWED">Reviewed</option>
              <option value="DISMISSED">Dismissed</option>
              <option value="ACTION_TAKEN">Action taken</option>
            </Select>
          </div>
          <Table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Reason</th>
                <th>Reporter</th>
                <th>Reported user</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {reportsQuery.data!.data.map((report: any) => (
                <tr key={report.id} className={selectedReportId === report.id ? 'row-selected' : ''} onClick={() => setSelectedReportId(report.id)}>
                  <td><Badge tone={report.status === 'PENDING' ? 'warning' : report.status === 'ACTION_TAKEN' ? 'danger' : 'success'}>{report.status}</Badge></td>
                  <td>{report.reason}</td>
                  <td>@{report.reporter?.username}</td>
                  <td>@{report.post?.author?.username}</td>
                  <td>{new Date(report.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          {!selectedReportId ? (
            <EmptyState title="No report selected" description="Choose a report to inspect details, notes, and resolution actions." />
          ) : reportDetailQuery.isLoading ? (
            <LoadingState label="Loading report detail…" />
          ) : reportDetailQuery.isError ? (
            <EmptyState title="Unable to load report" description={(reportDetailQuery.error as Error).message} />
          ) : (
            <div className="stack-list">
              <h3>Report detail</h3>
              <div className="muted small">Reporter: @{reportDetailQuery.data.reporter.username} • Reported user: @{reportDetailQuery.data.post.author.username}</div>
              <div className="content-preview">{reportDetailQuery.data.post.content}</div>
              <div className="inline-actions wrap-gap">
                <Button kind="secondary" onClick={() => updateStatusMutation.mutate({ status: 'REVIEWED' })}>Mark reviewed</Button>
                <Button kind="secondary" onClick={() => updateStatusMutation.mutate({ status: 'DISMISSED' })}>Dismiss</Button>
                <Button kind="danger" onClick={() => updateStatusMutation.mutate({ status: 'ACTION_TAKEN', removePost: true })}>Remove content</Button>
                <Button kind="danger" onClick={() => updateStatusMutation.mutate({ status: 'ACTION_TAKEN', suspendUser: true })}>Suspend user</Button>
                <Button kind="danger" onClick={() => updateStatusMutation.mutate({ status: 'ACTION_TAKEN', banUser: true })}>Ban user</Button>
              </div>
              {adminsQuery.data?.data?.length ? (
                <label>
                  <span>Assign moderator</span>
                  <Select defaultValue="" onChange={(event) => { if (event.target.value) assignMutation.mutate(event.target.value); }}>
                    <option value="">Select admin</option>
                    {adminsQuery.data.data.map((admin: any) => (
                      <option key={admin.id} value={admin.id}>{admin.user.username} ({admin.role})</option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <label>
                <span>Internal note</span>
                <TextArea rows={4} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add investigation notes" />
              </label>
              <Button onClick={() => noteMutation.mutate()} disabled={!note.trim()}>Add note</Button>
              <div>
                <strong>History</strong>
                <div className="stack-list compact">
                  {reportDetailQuery.data.history.map((entry: any) => (
                    <div key={entry.id} className="timeline-item">
                      <strong>{entry.action}</strong>
                      <div className="muted small">{entry.adminAccount?.user?.username || 'System'} • {new Date(entry.createdAt).toLocaleString()}</div>
                      {entry.reason ? <div>{entry.reason}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
