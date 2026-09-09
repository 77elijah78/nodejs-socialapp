import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiRequest } from '../lib/api';
import { Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, Table, TextArea } from '../components/ui';

export function MessagesPage() {
  const [search, setSearch] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [accessReason, setAccessReason] = useState('Investigating a report or support request');
  const [messageSearchReason, setMessageSearchReason] = useState('Moderation and safety review');
  const [messageSearch, setMessageSearch] = useState('');

  const conversationsQuery = useQuery({
    queryKey: ['admin-conversations', search],
    queryFn: async () => apiRequest<any[]>('/admin/messages/conversations', { query: { search } }),
  });

  const accessConversationMutation = useMutation({
    mutationFn: async () => {
      if (!selectedConversationId) throw new Error('Select a conversation');
      return apiRequest<any>(`/admin/messages/conversations/${selectedConversationId}/access`, {
        method: 'POST',
        body: { reason: accessReason },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to load conversation'),
  });

  const searchMessagesMutation = useMutation({
    mutationFn: async () => apiRequest<any[]>('/admin/messages/search', {
      method: 'POST',
      body: {
        search: messageSearch,
        reason: messageSearchReason,
      },
    }),
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to search messages'),
  });

  const removeMessageMutation = useMutation({
    mutationFn: async (messageId: string) => {
      const reason = window.prompt('Provide a reason for removing this message:');
      if (!reason) throw new Error('Reason is required');
      return apiRequest(`/admin/messages/${messageId}/remove`, { method: 'POST', body: { reason } });
    },
    onSuccess: () => {
      toast.success('Message removed');
      void accessConversationMutation.mutateAsync();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to remove message'),
  });

  if (conversationsQuery.isLoading) return <LoadingState label="Loading conversations…" />;
  if (conversationsQuery.isError) return <EmptyState title="Unable to load conversations" description={(conversationsQuery.error as Error).message} />;

  const selectedConversation = accessConversationMutation.data?.data;
  const messageSearchResults = searchMessagesMutation.data?.data || [];

  return (
    <div className="page-shell">
      <PageHeader title="Messaging administration" subtitle="Private message content requires explicit reason capture and audit logging on every access." />

      <div className="card-grid two-up">
        <Card>
          <div className="stack-list">
            <h3>Conversations</h3>
            <Input placeholder="Search participant or group" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="conversation-list">
              {conversationsQuery.data!.data.map((conversation: any) => (
                <button key={conversation.id} className={`conversation-item ${selectedConversationId === conversation.id ? 'active' : ''}`} onClick={() => setSelectedConversationId(conversation.id)}>
                  <div>
                    <strong>{conversation.isGroup ? conversation.groupName || 'Group conversation' : conversation.participants.map((participant: any) => `@${participant.user.username}`).join(', ')}</strong>
                    <div className="muted small">{conversation.lastMessage?.contentPreview || 'No messages yet'}</div>
                  </div>
                  <Badge tone="info">{conversation._count.messages} msgs</Badge>
                </button>
              ))}
            </div>
            <label>
              <span>Access reason</span>
              <TextArea rows={3} value={accessReason} onChange={(event) => setAccessReason(event.target.value)} />
            </label>
            <Button onClick={() => void accessConversationMutation.mutateAsync()} disabled={!selectedConversationId || accessConversationMutation.isPending}>
              {accessConversationMutation.isPending ? 'Loading conversation…' : 'Open conversation with audit log'}
            </Button>
          </div>
        </Card>

        <Card>
          <div className="stack-list">
            <h3>Conversation detail</h3>
            {!selectedConversation ? (
              <EmptyState title="No conversation opened" description="Select a conversation and provide a clear reason for access." />
            ) : (
              <>
                <div className="muted small">Participants: {selectedConversation.conversation.participants.map((participant: any) => `@${participant.user.username}`).join(', ')}</div>
                <Table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Sender</th>
                      <th>Message</th>
                      <th>Type</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedConversation.messages.map((message: any) => (
                      <tr key={message.id}>
                        <td>{new Date(message.createdAt).toLocaleString()}</td>
                        <td>@{message.sender?.username}</td>
                        <td className="cell-wrap">{message.deletedAt ? <em>Removed</em> : message.content || message.mediaUrl || '—'}</td>
                        <td>{message.type}</td>
                        <td>
                          {!message.deletedAt ? <Button kind="danger" onClick={() => removeMessageMutation.mutate(message.id)}>Remove</Button> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <div className="toolbar">
          <Input placeholder="Search message content" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} />
          <Input placeholder="Reason for search" value={messageSearchReason} onChange={(event) => setMessageSearchReason(event.target.value)} />
          <Button onClick={() => void searchMessagesMutation.mutateAsync()} disabled={!messageSearch.trim()}>Search messages</Button>
        </div>
        {messageSearchResults.length ? (
          <Table>
            <thead>
              <tr>
                <th>Message</th>
                <th>Conversation</th>
                <th>Sender</th>
                <th>Recipient</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {messageSearchResults.map((message: any) => (
                <tr key={message.id}>
                  <td className="cell-wrap">{message.deletedAt ? <em>Removed</em> : message.content}</td>
                  <td className="cell-mono">{message.conversationId}</td>
                  <td>@{message.sender?.username}</td>
                  <td>@{message.receiver?.username || '—'}</td>
                  <td>{new Date(message.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No message results yet" description="Run a permission-gated search when an incident requires it." />
        )}
      </Card>
    </div>
  );
}
