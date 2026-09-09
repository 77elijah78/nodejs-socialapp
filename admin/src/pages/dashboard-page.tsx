import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiRequest } from '../lib/api';
import { Badge, Card, EmptyState, LoadingState, PageHeader, StatCard, Table } from '../components/ui';

function chartDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DashboardPage() {
  const overviewQuery = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: async () => (await apiRequest<any>('/admin/dashboard/overview')).data,
  });

  if (overviewQuery.isLoading) return <LoadingState label="Loading dashboard…" />;
  if (overviewQuery.isError) return <EmptyState title="Unable to load dashboard" description={(overviewQuery.error as Error).message} />;

  const data = overviewQuery.data;
  const contentCreation = (data.charts.contentCreation.posts || []).map((entry: any, index: number) => ({
    date: chartDate(entry.bucket),
    posts: data.charts.contentCreation.posts[index]?.count || 0,
    stories: data.charts.contentCreation.stories[index]?.count || 0,
    comments: data.charts.contentCreation.comments[index]?.count || 0,
  }));
  const engagement = (data.charts.engagementOverTime.likes || []).map((entry: any, index: number) => ({
    date: chartDate(entry.bucket),
    likes: data.charts.engagementOverTime.likes[index]?.count || 0,
    shares: data.charts.engagementOverTime.shares[index]?.count || 0,
    messages: data.charts.engagementOverTime.messages[index]?.count || 0,
  }));

  return (
    <div className="page-shell">
      <PageHeader title="Dashboard" subtitle="Live operational overview driven by the existing PostgreSQL, Redis, and Kafka-backed platform." />

      <div className="stats-grid">
        <StatCard label="Total users" value={data.summary.totalUsers} helper={`${data.summary.newUsers} new in the last 7 days`} />
        <StatCard label="Active users (30d)" value={data.summary.activeUsers} helper={`${data.summary.dailyActiveUsers} active today`} />
        <StatCard label="Posts" value={data.summary.totalPosts} helper={`${data.summary.totalStories} stories`} />
        <StatCard label="Comments" value={data.summary.totalComments} helper={`${data.summary.totalLikes} likes`} />
        <StatCard label="Shares" value={data.summary.totalShares} helper={`${data.summary.totalMessages} total messages`} />
        <StatCard label="Moderation queue" value={data.summary.reportsAwaitingReview} helper={`${data.summary.suspendedUsers} suspended users`} />
      </div>

      <div className="card-grid two-up">
        <Card>
          <h3>User growth</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.charts.userGrowth.map((entry: any) => ({ date: chartDate(entry.bucket), users: entry.count }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Area type="monotone" dataKey="users" stroke="#7c3aed" fill="#c4b5fd" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <h3>Daily active users</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.charts.dailyActiveUsers.map((entry: any) => ({ date: chartDate(entry.bucket), activeUsers: entry.count }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="activeUsers" stroke="#0f766e" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <h3>Content creation</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={contentCreation}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="posts" fill="#2563eb" />
                <Bar dataKey="stories" fill="#db2777" />
                <Bar dataKey="comments" fill="#16a34a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <h3>Engagement over time</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={engagement}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="likes" stroke="#2563eb" />
                <Line type="monotone" dataKey="shares" stroke="#f59e0b" />
                <Line type="monotone" dataKey="messages" stroke="#7c3aed" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="card-grid two-up">
        <Card>
          <h3>Recent moderation activity</h3>
          <Table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Admin</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {data.recentModeration.map((item: any) => (
                <tr key={item.id}>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                  <td>{item.adminAccount?.user?.username || 'System'}</td>
                  <td>{item.action}</td>
                  <td>{item.targetType} {item.targetId || ''}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <h3>System health overview</h3>
          <div className="stack-list">
            {data.systemHealth.services.map((service: any) => (
              <div key={service.name} className="inline-between health-row">
                <div>
                  <strong>{service.name}</strong>
                  <div className="muted small">{service.healthy ? 'Operational' : service.error}</div>
                </div>
                <Badge tone={service.healthy ? 'success' : 'danger'}>{service.healthy ? `${service.durationMs}ms` : 'Degraded'}</Badge>
              </div>
            ))}
            {data.systemHealth.recentErrors?.length ? (
              <div className="error-log-preview">
                <strong>Recent errors</strong>
                <pre>{data.systemHealth.recentErrors.join('\n')}</pre>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
