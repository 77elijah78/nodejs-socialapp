import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../lib/api';
import { Badge, Card, EmptyState, LoadingState, PageHeader } from '../components/ui';

export function SystemPage() {
  const query = useQuery({
    queryKey: ['system-overview'],
    queryFn: async () => (await apiRequest<any>('/admin/system/overview')).data,
    refetchInterval: 30000,
  });

  if (query.isLoading) return <LoadingState label="Loading system health…" />;
  if (query.isError) return <EmptyState title="Unable to load system health" description={(query.error as Error).message} />;

  return (
    <div className="page-shell">
      <PageHeader title="System monitoring" subtitle="Real health checks from the backend service, PostgreSQL, Redis, Kafka, and media storage access." />
      <div className="card-grid two-up">
        {query.data.services.map((service: any) => (
          <Card key={service.name}>
            <div className="inline-between">
              <h3>{service.name}</h3>
              <Badge tone={service.healthy ? 'success' : 'danger'}>{service.healthy ? 'Healthy' : 'Degraded'}</Badge>
            </div>
            <p className="muted">{service.healthy ? `${service.durationMs}ms check` : service.error}</p>
            <pre className="json-inline">{JSON.stringify(service.details, null, 2)}</pre>
          </Card>
        ))}
      </div>
      <Card>
        <h3>Background jobs</h3>
        <div className="stack-list compact">
          {query.data.backgroundJobs.map((job: any) => (
            <div key={job.name} className="inline-between health-row">
              <span>{job.name}</span>
              <Badge tone={job.healthy ? 'success' : 'danger'}>{job.details}</Badge>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h3>Recent errors</h3>
        <pre className="error-log-preview">{query.data.recentErrors.length ? query.data.recentErrors.join('\n') : 'No recent error log entries available.'}</pre>
      </Card>
    </div>
  );
}
