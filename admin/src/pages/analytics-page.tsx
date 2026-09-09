import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiRequest } from '../lib/api';
import { Card, EmptyState, LoadingState, PageHeader, Select, StatCard } from '../components/ui';

function toDateInput(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function AnalyticsPage() {
  const [from, setFrom] = useState(toDateInput(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(toDateInput(new Date()));
  const [granularity, setGranularity] = useState('daily');

  const summaryQuery = useQuery({
    queryKey: ['analytics-summary', from, to],
    queryFn: async () => (await apiRequest<any>('/admin/analytics/summary', { query: { from, to } })).data,
  });

  const timeseriesQuery = useQuery({
    queryKey: ['analytics-timeseries', from, to, granularity],
    queryFn: async () => (await apiRequest<any>('/admin/analytics/timeseries', { query: { from, to, granularity, metrics: 'users,active_users,posts,stories,comments,likes,shares,messages,reports,resolved_reports,suspensions,bans' } })).data,
  });

  const combinedSeries = useMemo(() => {
    const lookup = new Map<string, any>();
    const metrics = timeseriesQuery.data || {};

    Object.entries(metrics).forEach(([metric, values]: [string, any]) => {
      values.forEach((entry: any) => {
        const key = entry.bucket;
        const current = lookup.get(key) || { date: new Date(entry.bucket).toLocaleDateString() };
        current[metric] = entry.count;
        lookup.set(key, current);
      });
    });

    return [...lookup.values()];
  }, [timeseriesQuery.data]);

  if (summaryQuery.isLoading || timeseriesQuery.isLoading) return <LoadingState label="Loading analytics…" />;
  if (summaryQuery.isError) return <EmptyState title="Unable to load analytics" description={(summaryQuery.error as Error).message} />;
  if (timeseriesQuery.isError) return <EmptyState title="Unable to load analytics series" description={(timeseriesQuery.error as Error).message} />;

  return (
    <div className="page-shell">
      <PageHeader title="Analytics" subtitle="Date-range reporting backed by live platform data with cached server-side aggregation." />
      <div className="toolbar">
        <label><span>From</span><input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span><input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label><span>Granularity</span>
          <Select value={granularity} onChange={(event) => setGranularity(event.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </label>
      </div>

      <div className="stats-grid">
        {Object.entries(summaryQuery.data).map(([label, value]) => (
          <StatCard key={label} label={label.replace(/([A-Z])/g, ' $1')} value={String(value)} />
        ))}
      </div>

      <div className="card-grid two-up">
        <Card>
          <h3>User and activity trends</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={combinedSeries}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line dataKey="users" stroke="#7c3aed" />
                <Line dataKey="active_users" stroke="#0f766e" />
                <Line dataKey="reports" stroke="#dc2626" />
                <Line dataKey="resolved_reports" stroke="#16a34a" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <h3>Content and engagement trends</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={combinedSeries}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line dataKey="posts" stroke="#2563eb" />
                <Line dataKey="stories" stroke="#db2777" />
                <Line dataKey="comments" stroke="#16a34a" />
                <Line dataKey="likes" stroke="#f59e0b" />
                <Line dataKey="shares" stroke="#9333ea" />
                <Line dataKey="messages" stroke="#6b7280" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}
