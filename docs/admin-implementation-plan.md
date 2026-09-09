# Admin Panel Implementation Plan

## Discovery summary

Repository inspection showed that the existing codebase is currently a **backend-only Node.js/TypeScript service** with:

- **Express 5** REST API
- **Prisma ORM** over **PostgreSQL**
- **Redis** for Socket.IO scaling and shared runtime connectivity
- **Kafka** for chat, notification, presence, and delivery/read event propagation
- **Socket.IO** for realtime messaging
- **Multer + local filesystem uploads** served from `/uploads`
- **Docker Compose** and **Kubernetes manifests** already present

### Existing architecture found

- No existing web frontend in this repository
- No existing admin frontend
- No existing admin API
- No existing RBAC/permission system
- No existing admin authentication layer beyond normal JWT login
- Existing moderation-related capability is limited to **post reports** (`reports` table)
- Existing media storage is **local disk** under `UPLOADS_PATH`
- Existing roles/permissions do **not** exist in the current schema

### Existing backend modules found

- `src/controllers/*` for auth, users, posts, messages, media
- `src/services/*` for core business logic
- `src/routes/*` for `/auth`, `/users`, `/posts`, `/messages`, `/media`
- `src/config/redis.ts` and `src/config/kafka.ts`
- `prisma/schema.prisma` with social, messaging, story, notification, and report models

## Implementation approach taken

Because the repository has no frontend stack to reuse, the admin panel was implemented as a **new React + TypeScript SPA** under `admin/`, and the backend now serves the built admin app at **`/admin`**.

## Architecture decisions

### Frontend
- New React/Vite/TypeScript admin application in `admin/`
- Permission-aware sidebar and routed views
- React Query for API data fetching and caching
- Recharts for operational dashboards and analytics
- Same-origin deployment through the existing Express backend

### Backend
- New admin API namespace under **`/api/v1/admin`**
- Reuse existing JWT authentication flow
- Add server-side admin authorization and granular permission checks
- Add audit logging for destructive actions and private message access
- Reuse existing Prisma/PostgreSQL architecture
- Use Redis caching where it provides direct operational value

### Database additions
- User moderation state fields
- Admin accounts and roles
- Audit log table
- Platform settings table
- Report note/assignment support
- Extra indexes for moderation and analytics workloads

## Phases completed

1. Discovery and architecture review
2. Admin auth + RBAC foundation
3. Admin SPA layout and routing
4. Dashboard, users, content, reports, messaging, analytics, settings, system monitoring
5. Audit logging and admin management
6. Deployment integration updates
