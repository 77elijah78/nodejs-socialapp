import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, Pagination, Select, Tabs, Table } from '../components/ui';

const tabs = [
  { label: 'Posts', value: 'posts' },
  { label: 'Stories', value: 'stories' },
  { label: 'Comments', value: 'comments' },
  { label: 'Likes', value: 'likes' },
  { label: 'Shares', value: 'shares' },
];

export function ContentPage() {
  const [tab, setTab] = useState('posts');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  const path = useMemo(() => {
    switch (tab) {
      case 'posts': return '/admin/content/posts';
      case 'stories': return '/admin/content/stories';
      case 'comments': return '/admin/content/comments';
      case 'likes': return '/admin/content/likes';
      case 'shares': return '/admin/content/shares';
      default: return '/admin/content/posts';
    }
  }, [tab]);

  const contentQuery = useQuery({
    queryKey: ['content', tab, page, search],
    queryFn: async () => apiRequest<any>(path, { query: { page, search } }),
  });

  const moderateMutation = useMutation({
    mutationFn: async ({ target, action, id }: { target: 'posts' | 'stories' | 'comments'; action: 'remove' | 'restore'; id: string }) => {
      const reason = window.prompt(`Provide a reason to ${action} this ${target.slice(0, -1)}:`);
      if (!reason) throw new Error('Reason is required');
      return apiRequest(`/admin/content/${target}/${id}/moderate`, { method: 'POST', body: { action, reason } });
    },
    onSuccess: () => {
      toast.success('Content updated');
      void queryClient.invalidateQueries({ queryKey: ['content'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update content'),
  });

  if (contentQuery.isLoading) return <LoadingState label="Loading content…" />;
  if (contentQuery.isError) return <EmptyState title="Unable to load content" description={(contentQuery.error as Error).message} />;

  const payload = contentQuery.data!.data;
  const items = Array.isArray(payload) ? payload : payload.items || [];
  const meta = contentQuery.data!.meta;

  return (
    <div className="page-shell">
      <PageHeader title="Content management" subtitle="Unified moderation tools for posts, stories, comments, likes, and available share activity records." />
      <Tabs tabs={tabs} value={tab} onChange={(value) => { setTab(value); setPage(1); }} />
      <div className="toolbar">
        <Input placeholder={`Search ${tab}`} value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} />
        {tab === 'shares' ? <Badge tone="warning">Message-based share records only</Badge> : null}
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Primary content</th>
              <th>Owner</th>
              <th>Created</th>
              <th>State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item: any) => {
              const state = item.deletedAt ? 'Removed' : item.expiresAt && new Date(item.expiresAt).getTime() < Date.now() ? 'Expired' : 'Active';
              const owner = item.author?.username || item.user?.username || item.sender?.username || item.authorId || item.userId || item.senderId || '—';
              const content = item.content || item.caption || item.mediaUrl || item.post?.content || item.id;
              return (
                <tr key={item.id || `${item.userId}-${item.postId}`}>
                  <td className="cell-mono">{item.id || `${item.userId}-${item.postId}`}</td>
                  <td className="cell-wrap">{typeof content === 'string' ? content.slice(0, 120) : JSON.stringify(content)}</td>
                  <td>{owner}</td>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                  <td><Badge tone={state === 'Active' ? 'success' : state === 'Expired' ? 'warning' : 'danger'}>{state}</Badge></td>
                  <td>
                    {tab === 'posts' || tab === 'stories' || tab === 'comments' ? (
                      <div className="inline-actions">
                        <Button kind="secondary" onClick={() => moderateMutation.mutate({ target: tab as any, action: item.deletedAt ? 'restore' : 'remove', id: item.id })}>{item.deletedAt ? 'Restore' : 'Remove'}</Button>
                      </div>
                    ) : (
                      <span className="muted small">Read only</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Pagination page={meta?.page || page} totalPages={meta?.totalPages || 1} onPageChange={setPage} />
    </div>
  );
}
