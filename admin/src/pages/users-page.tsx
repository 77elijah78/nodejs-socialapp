import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { Badge, Button, EmptyState, Input, LoadingState, PageHeader, Pagination, Select, Table } from '../components/ui';
import type { AdminUser } from '../lib/types';

function statusTone(status: string) {
  if (status === 'ACTIVE') return 'success';
  if (status === 'SUSPENDED') return 'warning';
  return 'danger';
}

export function UsersPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const queryClient = useQueryClient();

  const queryKey = useMemo(() => ['admin-users', page, search, status, role], [page, search, status, role]);
  const usersQuery = useQuery({
    queryKey,
    queryFn: async () => apiRequest<AdminUser[]>('/admin/users', { query: { page, search, status, role } }),
  });

  const actionMutation = useMutation({
    mutationFn: async ({ userId, action }: { userId: string; action: string }) => {
      const reason = window.prompt(`Provide a reason for ${action}:`);
      if (!reason) throw new Error('A reason is required');
      return apiRequest(`/admin/users/${userId}/actions`, { method: 'POST', body: { action, reason } });
    },
    onSuccess: () => {
      toast.success('User updated');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update user'),
  });

  if (usersQuery.isLoading) return <LoadingState label="Loading users…" />;
  if (usersQuery.isError) return <EmptyState title="Unable to load users" description={(usersQuery.error as Error).message} />;

  const users = usersQuery.data!.data;
  const meta = usersQuery.data!.meta;

  return (
    <div className="page-shell">
      <PageHeader title="Users" subtitle="Search, filter, review, and moderate user accounts without exposing sensitive secrets." />
      <div className="toolbar">
        <Input placeholder="Search username, display name, or email" value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} />
        <Select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="BANNED">Banned</option>
          <option value="DELETED">Deleted</option>
        </Select>
        <Select value={role} onChange={(event) => { setPage(1); setRole(event.target.value); }}>
          <option value="">All roles</option>
          <option value="USER">User</option>
          <option value="MODERATOR">Moderator</option>
          <option value="ADMIN">Admin</option>
          <option value="SUPER_ADMIN">Super Admin</option>
          <option value="SUPPORT_AGENT">Support Agent</option>
          <option value="ANALYST">Analyst</option>
        </Select>
      </div>

      <Table>
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Role</th>
            <th>Posts</th>
            <th>Followers</th>
            <th>Last active</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <div className="stack-tight">
                  <Link to={`/users/${user.id}`} className="table-link">@{user.username}</Link>
                  <span className="muted small">{user.email}</span>
                </div>
              </td>
              <td><Badge tone={statusTone(user.accountStatus) as any}>{user.accountStatus}</Badge></td>
              <td>{user.role || 'USER'}</td>
              <td>{user._count?.posts ?? 0}</td>
              <td>{user._count?.followers ?? 0}</td>
              <td>{user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : 'Never'}</td>
              <td>{new Date(user.createdAt).toLocaleDateString()}</td>
              <td>
                <div className="inline-actions">
                  <Link to={`/users/${user.id}`} className="button button-secondary">View</Link>
                  {user.accountStatus !== 'SUSPENDED' ? (
                    <Button kind="secondary" disabled={actionMutation.isPending} onClick={() => { if (window.confirm(`Suspend @${user.username}?`)) actionMutation.mutate({ userId: user.id, action: 'suspend' }); }}>Suspend</Button>
                  ) : (
                    <Button kind="secondary" disabled={actionMutation.isPending} onClick={() => { if (window.confirm(`Unsuspend @${user.username}?`)) actionMutation.mutate({ userId: user.id, action: 'unsuspend' }); }}>Unsuspend</Button>
                  )}
                  {user.accountStatus !== 'BANNED' ? (
                    <Button kind="danger" disabled={actionMutation.isPending} onClick={() => { if (window.confirm(`Ban @${user.username}?`)) actionMutation.mutate({ userId: user.id, action: 'ban' }); }}>Ban</Button>
                  ) : (
                    <Button kind="secondary" disabled={actionMutation.isPending} onClick={() => { if (window.confirm(`Unban @${user.username}?`)) actionMutation.mutate({ userId: user.id, action: 'unban' }); }}>Unban</Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Pagination page={meta?.page || page} totalPages={meta?.totalPages || 1} onPageChange={setPage} />
    </div>
  );
}
