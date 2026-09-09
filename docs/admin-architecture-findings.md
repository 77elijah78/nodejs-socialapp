# Architecture Findings

## Frontend
No existing web frontend or shared UI component library was present in this repository.

## Backend services and responsibilities
This repository contains a single backend service with these logical areas:
- Auth
- Users / follow graph
- Posts / likes / comments / stories
- Messaging / conversations / message lifecycle
- Media uploads
- Realtime Socket.IO handlers
- Kafka event production and consumption

## PostgreSQL / ORM
- ORM: Prisma
- Database: PostgreSQL
- Schema source: `prisma/schema.prisma`
- Migrations present in `prisma/migrations/*`

## Authentication
- JWT bearer authentication
- Refresh tokens persisted in PostgreSQL (`refresh_tokens`)
- No pre-existing admin auth layer before this implementation

## Redis usage
- Socket.IO Redis adapter pub/sub
- Shared Redis client available for caching / coordination

## Kafka usage
Topics found in code:
- `chat.messages`
- `chat.delivered`
- `chat.edited`
- `chat.deleted`
- `chat.deleted-for-me`
- `chat.conversation-deleted`
- `chat.notifications`
- `chat.presence`
- `chat.message-read`

## Media storage
- Local filesystem uploads
- Public URLs built from `BASE_URL + /uploads/...`
- No S3/R2/GCS integration in current repository

## Existing moderation capability before admin work
- Post reporting only
- Report statuses: `PENDING`, `REVIEWED`, `DISMISSED`, `ACTION_TAKEN`
- No admin routes, admin roles, audit logs, or moderation notes
