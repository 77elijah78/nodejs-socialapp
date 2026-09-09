# Admin API Documentation

Base path: `/api/v1/admin`

## Auth
- `GET /auth/me` — current admin session
- `GET /meta/permissions` — available permissions and role defaults

## Dashboard
- `GET /dashboard/overview`

## Users
- `GET /users`
- `GET /users/:id`
- `GET /users/:id/posts`
- `GET /users/:id/stories`
- `GET /users/:id/comments`
- `GET /users/:id/likes`
- `GET /users/:id/followers`
- `GET /users/:id/following`
- `GET /users/:id/reports`
- `GET /users/:id/moderation-history`
- `GET /users/:id/activity`
- `POST /users/:id/actions`
  - body: `{ action: 'suspend' | 'unsuspend' | 'ban' | 'unban' | 'delete' | 'restore' | 'verify' | 'unverify', reason: string }`
- `POST /users/:id/role`
  - body: `{ role, permissions?, reason }`

## Content
- `GET /content/posts`
- `GET /content/posts/:id`
- `POST /content/posts/:id/moderate`
- `GET /content/stories`
- `POST /content/stories/:id/moderate`
- `GET /content/comments`
- `POST /content/comments/:id/moderate`
- `GET /content/likes`
- `GET /content/shares`

## Messages
- `GET /messages/conversations`
- `POST /messages/search`
  - requires explicit `reason`
- `POST /messages/conversations/:conversationId/access`
  - requires explicit `reason`
- `POST /messages/:messageId/remove`

## Reports
- `GET /reports`
- `GET /reports/:id`
- `POST /reports/:id/assign`
- `POST /reports/:id/notes`
- `POST /reports/:id/status`

## Admin accounts
- `GET /admins`
- `POST /admins`
- `PATCH /admins/:id`
- `POST /admins/:id/disable`

## Audit logs
- `GET /audit-logs`
- `GET /audit-logs/export`

## Settings
- `GET /settings`
- `PUT /settings`

## Analytics
- `GET /analytics/summary?from&to`
- `GET /analytics/timeseries?from&to&granularity&metrics`

## System monitoring
- `GET /system/overview`
