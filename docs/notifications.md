# Notifications backend: audit, contract and operations

## Architecture / findings
This extends the existing Notification table and activityService, not a parallel
feed. MessageReceipt and the ReceiptOutbox schema/worker remain intact. The existing
Kafka topic is `chat.notifications`; sockets auto-join authenticated `user:<id>`
rooms and the Redis adapter distributes events across instances.

Before this change, likes/comments/follows already persisted notifications with
unique dedupe keys and outbox envelopes. Missing pieces were cursor pagination,
single read/dismiss, explicit reply metadata, undo lifecycle handling, efficient
unread counts, and guarded Kafka DTO delivery. Post-share notifications used direct
DB/Kafka calls or had no real-time publication. The share-to-conversation route
also did not actually send a message. These paths now send through the existing
message service, with share-count/notification/outbox writes in its transaction.

No comment-like model/action exists, so no comment-like notification is fabricated.
COMMENT replies keep their existing enum value for Expo compatibility and add
`metadata.interaction = COMMENT_REPLY` (or POST_COMMENT) and repliedToId.
MESSAGE/MENTION enum values remain reserved for existing/future producers; this
patch does not invent message or mention activity. Story sharing is still a legacy
incomplete action and does not produce a fake notification.

## Persistence and lifecycle
Notification IDs, recipient/actor/post/comment relations, legacy resourceId,
createdAt and dedupeKey are retained. New nullable fields: readAt, dismissedAt,
withdrawnAt, metadata; new version defaults to 1. New active-page composite index:
(userId,dismissedAt,withdrawnAt,createdAt,id), named notifications_active_page_idx.
Existing recipient/unread and recipient/time indexes are reused, not duplicated.

- LIKE: recipient is post author; key `like:<post>:<actor>`.
- COMMENT: post author and parent-comment author, distinct; key
  `comment:<created-comment>:<recipient>`. Parent must belong to the same live post.
- FOLLOW: recipient is followed user; key `follow:<actor>:<recipient>`.
- SHARE (post): recipient is post author; key `share:<post>:<actor>`.
- No self-notifications; inactive/deleted actors or recipients do not get new rows.
- Repeated active actions keep the same row and do not republish a new intent.
- Unlike/unfollow withdraw corresponding rows, removing them from lists/counts.
  Redo restores the keyed row, increments version, resets unread/readAt and publishes
  the same ID. It retains the original createdAt/order, not a new history entry.
- Comment deletion withdraws activity for that comment. Post deletion withdraws
  activity referencing that post. Admin/legacy deletion paths that bypass these
  services still yield null previews rather than leaking deleted content.
- Dismiss is a user-scoped soft deletion, never a physical delete of the dedupe key.
  Dismissed notifications stay dismissed even after undo/redo.
- Hard-deleted related actors/posts/comments use existing SetNull relations;
  unavailable/soft-deleted previews are null. Recipient deletion cascades records.
- Historical isRead=true records keep readAt=null because the actual timestamp is
  unknown; this migration does not manufacture a read time. New reads are idempotent.

Interaction, notification and outbox intent commit together for likes, comments,
follows and post shares. A server-only transaction callback in sendMessage enables
share atomicity without changing public message payloads or receipt architecture.
Actual user-initiated repeated shares may create separate share messages/counts;
the social notification remains one per actor/post. Message-send idempotency is not
introduced by this notification patch.

## Authenticated REST contract
Base: `/api/v1/notifications`. Bearer access JWT required on every route. The
existing `/api/v1/activity` routes operate on the same rows and retain their offset
contract when no cursor is supplied. Users cannot select a different recipient ID.

### GET /notifications?limit=20&cursor=<opaque-nextCursor>
Limit is an integer 1–100. First page omits cursor. Ordering is createdAt DESC,
id DESC. Fetches limit+1 rows, then batch-hydrates actors/posts/comments (no N+1).
The cursor includes timestamp and ID so dismissing/deleting its row does not break
pagination. It is a boundary, not a permission token. Newly inserted items ahead
of a cursor are obtained by refreshing the first page. Concurrent pagination is
not a database-wide snapshot.

Illustrative response (angle-bracket strings stand for actual returned values):
```json
{
  "success": true,
  "message": "Notifications",
  "data": {
    "items": [{
      "id": "<notification-uuid>",
      "userId": "<recipient-uuid>",
      "actorId": "<actor-uuid>",
      "type": "COMMENT",
      "content": "replied to your comment",
      "resourceId": "<post-uuid>",
      "postId": "<post-uuid>",
      "commentId": "<reply-comment-uuid>",
      "isRead": false,
      "readAt": null,
      "createdAt": "<ISO timestamp>",
      "version": 1,
      "metadata": {"interaction":"COMMENT_REPLY", "repliedToId":"<parent-uuid>"},
      "actor": {"id":"<actor-uuid>","username":"<username>","displayName":null,"avatarUrl":null},
      "post": {"id":"<post-uuid>","content":"<content>","imageUrls":[],"videoUrl":null,"mediaMetadata":null},
      "comment": {"id":"<reply-uuid>","postId":"<post-uuid>","content":"<comment>"}
    }],
    "unreadCount": 1
  },
  "meta": {"limit":20,"hasNext":false,"nextCursor":null}
}
```
Dedupe keys, password hashes, emails and internal outbox fields are not serialized.
Actor, post, comment and metadata can be null. Render unavailable previews safely.

### State endpoints
- GET `/notifications/unread-count`: data `{unreadCount}`. Executes COUNT only.
- POST `/notifications/:id/read`: returns the full safe notification DTO; repeated
  reads preserve readAt. Foreign, withdrawn, dismissed or missing ID: 404.
- POST `/notifications/read` body `{ids:[UUID,...]}`: 1–200 IDs, returns `{count}`
  newly changed visible owned rows. Foreign IDs are ignored; no ownership oracle.
- POST `/notifications/read-all`: no body, returns `{count}`. Scoped to visible
  unread rows owned by the caller; no unread notification content is loaded.
- DELETE `/notifications/:id`: returns `{id,dismissed:true}`; repeat is idempotent.
  Foreign or missing ID: 404. Underlying notification/dedupe key remains retained.

Same state routes are available under `/activity`. GET `/activity?page=1&limit=20`
retains `{items,total,unreadCount}` and existing offset meta. Supplying cursor uses
the cursor contract instead. Page is bounded to 1–10000 for legacy offset requests.

Responses use existing success/error envelopes. Invalid UUID/cursor/limit/body is
400, missing/invalid JWT is 401, banned/suspended accounts are rejected by existing
authentication policy. Unexpected production errors are sanitized by middleware.
There are no arbitrary actor/recipient/type creation endpoints for clients.

## Kafka / Socket.IO / retry
Notification intent is committed before Kafka publication. The fenced leased
ReceiptOutbox worker handles notification, notificationUpdated and notificationState
alongside existing message/receipt envelopes. No second worker/table is introduced.
The typed publishers use the existing `chat.notifications` topic and recipient key.

The consumer validates routing identity, resolves the stored ID and recipient,
checks account state, and rehydrates committed safe fields. It never inserts a
notification from Kafka. Rolling-deployment legacy events without IDs resolve a
matching persisted row; unmatched events are not converted to fake activity.
Delayed creation events for withdrawn/dismissed rows are suppressed. Delayed updates
after restoration emit the current row/version rather than an obsolete removal.
Malformed events reject processing rather than silently acknowledging their offset.

Socket server-to-client events:
- `notification:new`: the same DTO as a REST item. Existing id/type/content/actorId/
  resourceId/commentId/createdAt fields remain; previews, userId, state/version and
  metadata are additive. Delivered only to `user:<recipient>`.
- `notification:removed`: `{id,version,reason:"withdrawn"|"dismissed"}`; remove that
  item and reconcile unread count. Delivered only to its recipient.
- `notifications:sync`: `{reason}`; fetch first page and unread count. Reasons include
  state-changed, connected, adapter-reconnected and consumer-rejoined. State mutations
  create durable sync intents. Recovery broadcasts carry no user data or counts.

No client socket mutation/ACK contract is added; clients mutate through REST.
On connect/reconnect, fetch notifications through REST even if a sync hint was missed.
Socket.IO is not an offline queue; persisted rows are the recovery source. Use JWT
`handshake.auth.token`; production middleware and personal-room isolation are tested.

**Delivery is at-least-once, not exactly-once.** Kafka/outbox retries can repeat a
socket frame; clients must upsert by id and compare version, not append duplicate
items/toasts. Read state can change within the same logical version, so apply the
latest authoritative REST state after sync. There is no cross-request snapshot or
guaranteed ordering between HTTP responses and socket delivery. After a crash or
Redis outage REST reconciliation is required. Stable IDs prevent duplicate logical
notifications; this does not promise exactly-once transient banners on every phone.

## Migration / rollout
New migration: `20261031010000_notification_lifecycle`.
It is additive. It preserves all rows and backfills a retry key on the latest
identifiable legacy LIKE/FOLLOW/SHARE/COMMENT record when no keyed row exists.
Older historical duplicates remain; records without an identifiable related entity
are not guessed or deleted. Review legacy duplicates separately if needed.

Back up PostgreSQL first. Do not reset a database. With the current dev Compose:
```sh
docker compose -f docker-compose.dev.yml up -d postgres redis zookeeper kafka
docker compose -f docker-compose.dev.yml build app
docker compose -f docker-compose.dev.yml run --rm --no-deps app npx prisma migrate deploy
docker compose -f docker-compose.dev.yml up -d --force-recreate app
```
For production Compose (tools-profile migration service):
```sh
docker compose --profile tools build migrate
docker compose --profile tools run --rm migrate
docker compose build app
docker compose up -d app
```
Non-Docker: `npm ci`, `npm run db:generate`, `npx prisma migrate deploy`,
`npm run build`, restart the managed application process. Never use migrate reset.
The earlier messaging/media migrations are prerequisites and migrate deploy applies
all pending migrations in order. Rebuild generated Prisma clients after schema changes.

Roll out all consumers/outbox publishers together; older workers do not understand
new lifecycle envelopes and older consumers do not understand sync markers. Pause
workers/traffic or use a coordinated rollout, preserving pending outbox rows.
No new environment variables/topics are needed. Configure existing DATABASE_URL,
REDIS_URL, KAFKA_BROKERS, KAFKA_GROUP_ID, JWT_SECRET and allowed client origins.
Keep PostgreSQL volumes/backups, Kafka topics and Redis Socket.IO adapter healthy.
Monitor retained outbox attempts/age, Kafka consumer lag, and malformed events.
Malformed records can block a partition pending operator remediation, consistent
with the existing receipt-consumer policy. Broker credentials/TLS and production
network exposure remain deployment responsibilities.

## Tests and remaining verification
Automated: 42 passing tests in `npm test` (existing regression tests included).
New coverage: reply recipients/metadata, self suppression, retry keys, cursor ties/
insertions/dismissals, single/bulk read state, unread counts, authorization and
validation, dismissal, unlike/unfollow restoration, deleted previews, share outbox,
Kafka retry stable IDs, stale event suppression, rollback on notification publication
intent failure, legacy migration/backfill preservation, actual JWT-authenticated
Socket.IO personal-room delivery and recipient reconnect REST recovery.

A filesystem-backed PGlite test closes/reopens the database and reloads the service,
verifying persisted notifications and outbox intents. Prisma SQL runs against PGlite;
Kafka is a boundary double. This verifies persistence across service/database reopen,
**not a Docker-volume restart or live PostgreSQL/Kafka/Redis failover**.
No Docker daemon, external broker cluster or physical phone was available. Validate
those failure/restart paths in the deployment before calling the system production
verified. The current dependency audit reports 25 vulnerabilities; this notification
patch does not upgrade unrelated dependencies. Bulk withdrawal currently fans out
per affected notification; stress-test large post deletions and monitor transaction
duration before high-volume rollout.

## Files for this notification change
- prisma/schema.prisma; prisma/migrations/20261031010000_notification_lifecycle/migration.sql
- src/services/activity.service.ts; src/routes/activity.routes.ts; src/routes/index.ts
- src/middlewares/schemas.ts
- src/services/post.service.ts; src/services/user.service.ts
- src/services/message.service.ts (server-only atomic share callback)
- src/services/receipt-outbox.service.ts; src/kafka/producer.ts; src/kafka/consumer.ts
- src/socket/authenticate.ts (extracted existing auth for reuse/tests); src/socket/index.ts
- test/receipts.test.mjs; docs/notifications.md; docs/production-readiness.md
