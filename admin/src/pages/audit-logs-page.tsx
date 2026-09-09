import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, getStoredAccessToken } from '../lib/api';
import { Button, EmptyState, Input, LoadingState, PageHeader, Pagination, Table } from '../components/ui';

export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['audit-logs', page, search],
    queryFn: async () => apiRequest<any[]>('/admin/audit-logs', { query: { page, search } }),
  });

  const exportCsv = async () => {
    const response = await fetch('/api/v1/admin/audit-logs/export', {
      headers: {
        Authorization: `Bearer ${getStoredAccessToken() || ''}`,
      },
    });
    const csv = await response.text();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'audit-logs.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (query.isLoading) return <LoadingState label="Loading audit logs…" />;
  if (query.isError) return <EmptyState title="Unable to load audit logs" description={(query.error as Error).message} />;

  return (
    <div className="page-shell">
      <PageHeader title="Audit logs" subtitle="Immutable record of high-risk administrative actions and sensitive content access." actions={<Button kind="secondary" onClick={() => void exportCsv()}>Export CSV</Button>} />
      <div className="toolbar">
        <Input placeholder="Search by admin, action, target type, or reason" value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} />
      </div>
      <Table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Admin</th>
            <th>Action</th>
            <th>Target</th>
            <th>Reason</th>
            <th>Metadata</th>
          </tr>
        </thead>
        <tbody>
          {query.data!.data.map((item: any) => (
            <tr key={item.id}>
              <td>{new Date(item.createdAt).toLocaleString()}</td>
              <td>{item.adminAccount?.user?.username || 'System'}</td>
              <td>{item.action}</td>
              <td>{item.targetType} {item.targetId || ''}</td>
              <td className="cell-wrap">{item.reason || '—'}</td>
              <td><pre className="json-inline">{JSON.stringify(item.metadata, null, 2)}</pre></td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Pagination page={query.data!.meta?.page || 1} totalPages={query.data!.meta?.totalPages || 1} onPageChange={setPage} />
    </div>
  );
}
