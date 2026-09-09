import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, Select, Table } from '../components/ui';

export function AdminsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    displayName: '',
    role: 'MODERATOR',
  });

  const accountsQuery = useQuery({
    queryKey: ['admin-accounts'],
    queryFn: async () => (await apiRequest<any[]>('/admin/admins')).data,
  });

  const createMutation = useMutation({
    mutationFn: async () => apiRequest('/admin/admins', { method: 'POST', body: form }),
    onSuccess: () => {
      toast.success('Admin account created');
      setForm({ username: '', email: '', password: '', displayName: '', role: 'MODERATOR' });
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to create admin'),
  });

  const disableMutation = useMutation({
    mutationFn: async (id: string) => {
      const reason = window.prompt('Why are you disabling this admin account?');
      if (!reason) throw new Error('Reason is required');
      return apiRequest(`/admin/admins/${id}/disable`, { method: 'POST', body: { reason } });
    },
    onSuccess: () => {
      toast.success('Admin account disabled');
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to disable admin'),
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: string }) => {
      const reason = window.prompt('Why are you changing this admin role?') || 'Role update';
      return apiRequest(`/admin/admins/${id}`, { method: 'PATCH', body: { role, reason } });
    },
    onSuccess: () => {
      toast.success('Admin role updated');
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update admin'),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate();
  };

  if (accountsQuery.isLoading) return <LoadingState label="Loading admin accounts…" />;
  if (accountsQuery.isError) return <EmptyState title="Unable to load admins" description={(accountsQuery.error as Error).message} />;

  return (
    <div className="page-shell">
      <PageHeader title="Admin management" subtitle="Create admin accounts, assign roles, disable access, and review administrator activity." />

      <div className="card-grid two-up">
        <Card>
          <h3>Create admin account</h3>
          <form className="form-grid" onSubmit={onSubmit}>
            <label><span>Username</span><Input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} required /></label>
            <label><span>Email</span><Input type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} required /></label>
            <label><span>Password</span><Input type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} required /></label>
            <label><span>Display name</span><Input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} /></label>
            <label><span>Role</span>
              <Select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}>
                <option value="MODERATOR">Moderator</option>
                <option value="ADMIN">Admin</option>
                <option value="SUPPORT_AGENT">Support Agent</option>
                <option value="ANALYST">Analyst</option>
              </Select>
            </label>
            <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Creating…' : 'Create admin'}</Button>
          </form>
        </Card>

        <Card>
          <h3>Existing admin accounts</h3>
          <Table>
            <thead>
              <tr>
                <th>Admin</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accountsQuery.data!.map((account: any) => (
                <tr key={account.id}>
                  <td>
                    <div className="stack-tight">
                      <strong>@{account.user.username}</strong>
                      <span className="muted small">{account.user.email}</span>
                    </div>
                  </td>
                  <td>
                    <Select value={account.role} onChange={(event) => updateRoleMutation.mutate({ id: account.id, role: event.target.value })}>
                      <option value="MODERATOR">Moderator</option>
                      <option value="ADMIN">Admin</option>
                      <option value="SUPPORT_AGENT">Support Agent</option>
                      <option value="ANALYST">Analyst</option>
                      <option value="SUPER_ADMIN">Super Admin</option>
                    </Select>
                  </td>
                  <td><Badge tone={account.isActive ? 'success' : 'danger'}>{account.isActive ? 'Active' : 'Disabled'}</Badge></td>
                  <td>{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : 'Never'}</td>
                  <td>
                    {account.isActive ? <Button kind="danger" onClick={() => disableMutation.mutate(account.id)}>Disable</Button> : <span className="muted small">Disabled</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
