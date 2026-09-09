import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { Badge, Button, Card, EmptyState, KeyValueGrid, LoadingState, PageHeader, Tabs, Table } from '../components/ui';
import type { AdminUser } from '../lib/types';

const tabs = [
  { label: 'Overview', value: 'overview' },
  { label: 'Profile information', value: 'profile' },
  { label: 'Posts', value: 'posts' },
  { label: 'Stories', value: 'stories' },
  { label: 'Comments', value: 'comments' },
  { label: 'Likes', value: 'likes' },
  { label: 'Shares', value: 'shares' },
  { label: 'Followers', value: 'followers' },
  { label: 'Following', value: 'following' },
  { label: 'Reports', value: 'reports' },
  { label: 'Moderation history', value: 'moderation-history' },
  { label: 'Login/activity history', value: 'activity' },
];

function renderJson(value: unknown) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState('overview');
  const queryClient = useQueryClient();

  const userQuery = useQuery({
    queryKey: ['admin-user', id],
    queryFn: async () => (await apiRequest<AdminUser>(`/admin/users/${id}`)).data,
  });

  const resourcePath = useMemo(() => {
    switch (tab) {
      case 'posts': return `/admin/users/${id}/posts`;
      case 'stories': return `/admin/users/${id}/stories`;
      case 'comments': return `/admin/users/${id}/comments`;
      case 'likes': return `/admin/users/${id}/likes`;
      case 'shares': return `/admin/content/shares`;
      case 'followers': return `/admin/users/${id}/followers`;
      case 'following': return `/admin/users/${id}/following`;
      case 'reports': return `/admin/users/${id}/reports`;
      case 'moderation-history': return `/admin/users/${id}/moderation-history`;
      case 'activity': return `/admin/users/${id}/activity`;
      default: return null;
    }
  }, [id, tab]);

  const resourceQuery = useQuery({
    queryKey: ['admin-user-resource', id, tab],
    enabled: Boolean(resourcePath),
    queryFn: async () => {
      const response = await apiRequest<any>(resourcePath!, { query: tab === 'shares' ? { userId: id } : undefined });
      return response.data;
    },
  });

  const actionMutation = useMutation({
    mutationFn: async (action: string) => {
      const reason = window.prompt(`Provide a reason for ${action}:`);
      if (!reason) throw new Error('Reason is required');
      return apiRequest(`/admin/users/${id}/actions`, { method: 'POST', body: { action, reason } });
    },
    onSuccess: () => {
      toast.success('User updated');
      void queryClient.invalidateQueries({ queryKey: ['admin-user', id] });
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update user'),
  });

  if (userQuery.isLoading) return <LoadingState label="Loading user…" />;
  if (userQuery.isError) return <EmptyState title="Unable to load user" description={(userQuery.error as Error).message} />;

  const user = userQuery.data!;

  return (
    <div className="page-shell">
      <PageHeader
        title={`@${user.username}`}
        subtitle="Detailed operational profile for moderation, support, and investigation."
        actions={
          <div className="inline-actions">
            <Button kind="secondary" onClick={() => actionMutation.mutate(user.isVerified ? 'unverify' : 'verify')}>{user.isVerified ? 'Unverify' : 'Verify'}</Button>
            <Button kind="secondary" onClick={() => actionMutation.mutate(user.accountStatus === 'SUSPENDED' ? 'unsuspend' : 'suspend')}>{user.accountStatus === 'SUSPENDED' ? 'Unsuspend' : 'Suspend'}</Button>
            <Button kind="danger" onClick={() => actionMutation.mutate(user.accountStatus === 'BANNED' ? 'unban' : 'ban')}>{user.accountStatus === 'BANNED' ? 'Unban' : 'Ban'}</Button>
          </div>
        }
      />

      <Card>
        <div className="inline-between wrap-gap">
          <div>
            <h2>{user.displayName || user.username}</h2>
            <div className="inline-actions">
              <Badge tone={user.accountStatus === 'ACTIVE' ? 'success' : user.accountStatus === 'SUSPENDED' ? 'warning' : 'danger'}>{user.accountStatus}</Badge>
              <Badge tone="info">{user.role || 'USER'}</Badge>
              {user.isVerified ? <Badge tone="success">Verified</Badge> : null}
            </div>
          </div>
          <div className="muted small">Created {new Date(user.createdAt).toLocaleString()}</div>
        </div>
      </Card>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' ? (
        <KeyValueGrid
          items={[
            { label: 'Email', value: user.email },
            { label: 'Display name', value: user.displayName || '—' },
            { label: 'Last active', value: user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : 'Never' },
            { label: 'Posts', value: user._count?.posts ?? 0 },
            { label: 'Stories', value: user._count?.stories ?? 0 },
            { label: 'Comments', value: user._count?.comments ?? 0 },
            { label: 'Likes', value: user._count?.likes ?? 0 },
            { label: 'Followers', value: user._count?.followers ?? 0 },
            { label: 'Following', value: user._count?.following ?? 0 },
            { label: 'Reports filed', value: user._count?.reports ?? 0 },
            { label: 'Reports against posts', value: user.reportsAgainstUser ?? 0 },
            { label: 'Stored sessions', value: user._count?.refreshTokens ?? 0 },
          ]}
        />
      ) : null}

      {tab === 'profile' ? (
        <Card>
          <KeyValueGrid
            items={[
              { label: 'Username', value: user.username },
              { label: 'Email', value: user.email },
              { label: 'Display name', value: user.displayName || '—' },
              { label: 'Bio', value: user.bio || '—' },
              { label: 'Avatar URL', value: user.avatarUrl || '—' },
              { label: 'Role', value: user.role || 'USER' },
              { label: 'Status', value: user.accountStatus },
            ]}
          />
        </Card>
      ) : null}

      {resourcePath ? (
        resourceQuery.isLoading ? (
          <LoadingState label="Loading tab data…" />
        ) : resourceQuery.isError ? (
          <EmptyState title="Unable to load tab" description={(resourceQuery.error as Error).message} />
        ) : tab === 'reports' ? (
          <div className="card-grid two-up">
            <Card>
              <h3>Reports filed by user</h3>
              {renderJson(resourceQuery.data.filedByUser)}
            </Card>
            <Card>
              <h3>Reports against this user's posts</h3>
              {renderJson(resourceQuery.data.reportsAgainstUser)}
            </Card>
          </div>
        ) : Array.isArray(resourceQuery.data) ? (
          <Card>
            <Table>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {resourceQuery.data.map((item: any) => (
                  <tr key={item.id || item.postId || item.userId || JSON.stringify(item)}>
                    <td>{item.id || item.postId || item.userId || item.username || 'Record'}</td>
                    <td>{renderJson(item)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : (
          <Card>{renderJson(resourceQuery.data)}</Card>
        )
      ) : null}
    </div>
  );
}
