# Messaging contracts and audit (2026-10-30)

## Authentication and existing interfaces
REST messaging routes (mounted under the existing message router) require Bearer JWT.
Socket.IO requires `handshake.auth.token` (or Authorization header); personal room
`user:<authenticated id>` is joined automatically. Never accept a client user ID.
Conversation joins and typing now check active membership.

Existing REST interfaces retained:
- GET `/conversations`, GET `/conversations/:conversationId/messages` (`page`, `limit`, `cursorId`, `before` epoch ms).
- POST `/conversations/:conversationId/messages` and `/conversations/:conversationId/reply`.
- POST `/messages/:messageId/edit`, DELETE `/messages/:messageId` with `{deleteFor:"me"|"everyone"}` (default me).
- POST `/delivered` `{messageIds}`, GET `/pending/delivery?limit=50`.
- POST `/receipts/sync` `{messageIds}` (max 200, outgoing IDs only); deleted-for-everyone results include deletedAt/deletedBy.
- POST `/conversations/:conversationId/read` remains an **explicit bulk action**. Do not call on history fetch, navigation, or partial visibility.

Send/reply bodies: `content` (max 5000, may be empty for media), `receiverId?`,
`type?` (TEXT/IMAGE/VIDEO/AUDIO/DOCUMENT/SHARED_POST/SHARED_STORY), `mediaUrl?`,
`thumbnailUrl?`, `duration?`, `repliedToId?` (required for reply), `fileName?`,
`fileMimeType?`, `fileSize?` (nonnegative integer), `sharedReference?` (JSON object).
At least content or mediaUrl is required by REST/socket validation.
Shared reference convention: `{id, kind:"post"|"story", preview:{...}}`.
Legacy shared content IDs remain readable; missing historical metadata is not invented.

REST uses existing success/pagination envelopes and error middleware (400 validation,
403 authorization, 404 missing resource). Send returns the persisted message.
`repliedTo` is null or the original message including conversationId, senderId,
`sender:{id,username,displayName,avatarUrl}`, type, content, mediaUrl, thumbnailUrl,
duration, fileName, fileMimeType, fileSize, sharedReference, deletedAt/deletedBy.
History, pending delivery, send acknowledgments, Kafka `message`, and `message:new`
use this same nested representation. Dates serialize as ISO strings. Tombstones keep
ID/type/relationships but redact content and all media/preview metadata.

## New batch interface
POST `/messages/delete-batch` or socket `message:delete-batch`:
```json
{"conversationId":"UUID","messageIds":["UUID","UUID"],"deleteFor":"me"}
```
1–200 IDs, deduplicated in first-seen order. Active membership required. Each unique
ID gets its own transaction and result; this intentionally permits partial success.
```json
{"conversationId":"UUID","deleteFor":"me","results":[
  {"messageId":"UUID","deleteFor":"me","success":true},
  {"messageId":"UUID","success":false,"error":"Only the sender can delete for everyone"}
]}
```
REST wraps this in the normal success envelope. Socket adds `success:true` at top
level to indicate the batch was accepted, not that every item succeeded. Invalid
batch shape/membership returns socket `{success:false,error}`. Check every result.
Single `message:delete` remains supported with conversationId, messageId, deleteFor;
it now validates the conversation matches. Me allows deleting anyone's message;
everyone requires active membership and sender ownership. No time limit existed;
none has been introduced. Repeats are idempotent and may repeat confirmation events.

## Events and retry
Existing incoming event names are unchanged: `message:new`, `message:notification`,
`message:read`, `message:delivered`, `message:edited`, `message:deleted`,
`message:deleted-for-me`, `conversation:deleted`, `receipts:resync`.
Send/reply ACKs add `message` alongside existing success/messageId. Failures retain
`{success:false,error}`. Individual `message:read` requires conversationId/messageId;
ACK success follows committed receipt/outbox persistence. Delivery input remains
messageIds plus optional legacy conversationId; authorization is per message.
Read/delivery events identify messageId, conversationId, userId and timestamp;
read events go to reader and sender personal rooms, delivery to sender.
Deletion events carry messageId/conversationId (everyone also deletedAt/deletedBy).
Everyone deletion now targets all active participants' personal rooms.

MessageReceipt composite key and independent group receipts are retained. Aggregate
message READ means **any** recipient read, not all. `readByMe` remains viewer-specific.
History never marks read. Duplicate reads retain the original readAt; read implies
a deliveredAt if absent. Late delivered ACKs cannot overwrite aggregate READ.

The existing ReceiptOutbox table, fenced claims, backoff and worker are reused.
Legacy receipt payloads remain supported; new envelopes `{kind,event}` handle new
messages, delivery and deletion. Message+recipient receipts+event intents commit
atomically. Consumer rehydrates new message envelopes before emission, suppressing
personally deleted messages and redacting subsequently deleted originals. Kafka
failures propagate/retry. Delivery is at-least-once, not exactly-once: frontend must
upsert by message ID and receipt key and reconcile history on reconnect. Offline
Socket.IO delivery is not durable; REST history is the recovery source.

## Migration / deployment
Apply `20261030010000_message_deletions_metadata` with normal `prisma migrate deploy`
before deploying this code; generate Prisma client. No production migration/reset
was performed here. Adds MessageDeletion with composite PK, cascading FKs and
user/timestamp index; nullable message metadata columns; conversation/time/ID index.
Existing MessageReceipt/ReceiptOutbox schemas are unchanged. Roll forward all
consumers/producers together before accepting new envelope publications.

## Confirmed root causes / limitations
- REST and Kafka selected/reconstructed different incomplete reply fields: shared include/serializer now used.
- Personal deletion only emitted a notification: persistent upsert and history/pending/sync/last-message/unread filtering added.
- Sender-only deletion guard applied to both modes: separate authorization now enforced with row locks and retained tombstones.
- Single-only deletion: additive bounded partial-success batch contract.
- New messages/delivered events had a commit/publication gap: existing durable worker extended.
- Shared-post-to-user bypassed message service/receipts/events: routed through normal send with preview snapshot.
- Unchecked room joins leaked conversation events: membership checks added.

Media storage has no reference-counted garbage collector. This change deliberately
never unlinks shared files; DB tombstones redact URLs, but physical storage reclamation
and revocation of previously public URLs remain outstanding. No claim of orphan-free
storage cleanup is made. Shared previews are snapshots, not live permission-aware
post/story hydration. Existing conversation-list unread counts still use per-conversation
queries. Edit publication and conversation deletion still use their legacy direct
Kafka paths; broad ordering across Kafka topics is not guaranteed. Existing stale-DM
recreation behavior can hard-delete archived conversation history and was not redesigned.
Live Kafka/Redis/PostgreSQL failover, multi-pod behavior and Expo rendering were not tested.

## Verification
`npm run build`: pass. `npm run db:validate:wasm`: pass (21 models).
`npm test`: 24 passing tests against PGlite applying migrations with actual Prisma
queries, Kafka boundary doubles, and real Socket.IO for receipt routing. Coverage
includes seven reply types, deleted originals, cross-conversation reply rejection,
persistent/idempotent personal deletion, mixed/cross-conversation batches, retry,
personal-room routing, duplicate stable IDs, group receipts, unauthorized reads,
read/delivery races, claim fencing, receipt HTTP recovery and rollback.
Not all new batch HTTP/socket combinations or real broker reconnection scenarios
have end-to-end tests. Dependency install reports 15 audit vulnerabilities; dependency
upgrades were not bundled with this messaging patch.
