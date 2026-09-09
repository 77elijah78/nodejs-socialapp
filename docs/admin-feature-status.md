# Feature Status

## Implemented
- Separate admin SPA (`admin/`) served by the backend at `/admin`
- Admin authentication using existing JWT login + admin account verification
- Role-based and permission-based backend authorization
- Dashboard summary, charts, recent moderation activity, system health snapshot
- User list, filtering, detail page, moderation actions, related resources
- Unified content management for posts, stories, comments, likes, and available share records
- Messaging administration with reason-gated access and audit logging
- Reports queue, detail, notes, assignment, and resolution actions
- Admin account management
- Audit log browsing and CSV export
- Platform settings management for safe app-level settings
- Analytics summary and time series endpoints with Redis caching
- System monitoring for DB, Redis, Kafka, uploads, and recent backend errors
- Prisma migration for admin foundation and moderation fields
- Admin-aware Docker build integration

## Requires further backend/product support
- Full share event investigation coverage: current backend stores aggregate `post.shareCount` and some message-based share events, but not every share as a first-class record
- Safe user-facing message reporting workflow: admin message access/removal exists, but end-user message report submission is not present in the current product backend
- Fine-grained per-user messaging restrictions: not present in existing application architecture
- External media object storage integration (S3/R2/GCS): current project still uses local disk storage
- Production monitoring integrations beyond health probes and log tail parsing (Prometheus/Grafana/Datadog)
- Stronger analytics materialization/outbox pipelines for very large production datasets
