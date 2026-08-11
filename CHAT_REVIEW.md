# Chat System Review — Phases 3–5 (Continued)

## 3. What Is Correct
- **Socket.IO JWT auth** is properly implemented (`src/socket/index.ts:39-54`).
- **Redis adapter** correctly configured for multi-instance room routing.
- **Kafka producer idempotency** enabled (`idempotent: true`).
- **Message status reconciliation** in `syncFromServer` prevents downgrades.
- **Visibility-based reads** correctly scoped to visible FlatList items.
- **Reconnect sync** runs globally with dedup flag and ACK after persistence.
- **No automatic reads** on join/connect/message arrival.
- **Backend ACK handler** uses `socket.userId` (authenticated identity).

## 4. Critical Bugs

### Bug 1: Unread count queries broken
- **Severity:** Critical
- **File:** `G:\Projects\Codes\Front End\Apps\socialApp\src\db\getQueries.ts:77`
- **Function:** `getUnreadCount`
- **Issue:** `eq(messages.senderId, "")` filters messages with empty senderId, which never occurs for real messages.
- **Scenario:** Unread badge always shows 0.
- **Smallest safe fix:** Change to `ne(messages.senderId, currentUserId)` or pass senderId as parameter.

### Bug 2: `getAllUnreadCounts` inflates counts
- **Severity:** Critical
- **File:** `G:\Projects\Codes\Front End\Apps\socialApp\src\db\getQueries.ts:91`
- **Function:** `getAllUnreadCounts`
- **Issue:** `where(ne(messages.status, "READ"))` counts ALL non-read messages, including sent ones.
- **Scenario:** Conversation list shows inflated unread counts including user's own messages.
- **Smallest safe fix:** Add `eq(messages.receiverId, currentUserId)` or `ne(messages.senderId, currentUserId)`.

### Bug 3: Delivery ACK dedup race
- **Severity:** Critical
- **File:** `G:\Projects\Codes\Front End\Apps\socialApp\src\services\SocketReceiver.ts:226` & `:747`
- **Function:** `message:new` + `syncPendingDelivery`
- **Issue:** `deliveredAckSet.add(messageId)` happens **before** `socket.emit`. If emit fails after set update, message won't be retried on reconnect.
- **Scenario:** Socket disconnects microsecond after ACK emit is queued but before server receives it. Backend never gets ACK, message stays SENT forever.
- **Smallest safe fix:** Move `deliveredAckSet.add` inside `try` block after successful emit, or clear on disconnect/reconnect.

### Bug 4: `markMessagesDelivered` missing conversation scoping
- **Severity:** Critical
- **File:** `Backend/src/services/message.service.ts:271-301`
- **Function:** `markMessagesDelivered`
- **Issue:** `updateMany` doesn't filter by `conversationId`. If client sends messageIds from different conversations, ALL matching IDs get DELIVERED regardless of conversation context.
- **Scenario:** User opens two chats, ACKs delivery in one, but payload includes IDs from another conversation. Both conversations' messages get marked DELIVERED.
- **Smallest safe fix:** Add `conversationId` to backend validation or split by conversation before update.

### Bug 5: No receiver validation in backend delivery handler
- **Severity:** High
- **File:** `Backend/src/socket/chat.handler.ts:157-172`
- **Function:** `message:delivered` handler
- **Issue:** No validation that `socket.userId` is actually the `receiverId` of the messages being ACKed.
- **Scenario:** Malicious client connects as user A, emits `message:delivered` with messageIds from user B's messages. Backend marks them DELIVERED.
- **Smallest safe fix:** Query messages first, verify `receiverId === socket.userId` for each before updating.

### Bug 6: Sync runs on initial connect, not just reconnect
- **Severity:** High
- **File:** `Frontend/src/services/SocketReceiver.ts:175`
- **Function:** `syncPendingDelivery` call
- **Issue:** Called on EVERY connect, including initial connection.
- **Scenario:** User opens app 50 times a day → 50 unnecessary REST calls to `/pending/delivery`.
- **Smallest safe fix:** Move call inside `if (isReconnect)` block.

### Bug 7: `deliveredAckSet` never cleared on disconnect
- **Severity:** High
- **File:** `Frontend/src/services/SocketReceiver.ts:747`
- **Function:** `syncPendingDelivery`
- **Issue:** If socket reconnects with new auth token (e.g., after refresh), old ACK IDs block re-ACKing messages that might need re-delivery.
- **Scenario:** User logs out and back in quickly. Old ACK set prevents delivery of messages that arrived during logout gap.
- **Smallest safe fix:** Clear `deliveredAckSet` on `disconnect` or `connect` before running sync.

### Bug 8: `markRoomAsRead` uses timestamp cursor
- **Severity:** High
- **File:** `Frontend/src/db/updateQueries.ts:37-52`
- **Function:** `markDelivered`
- **Issue:** Updates ALL messages in conversation with `lte(timestamp, upToTimestamp)`. If `upToTimestamp` is `Date.now()` and a new message arrives between query and update, it gets marked READ without visibility.
- **Scenario:** User opens chat, new message arrives during `markRoomAsRead` execution. New message is marked READ without being visible.
- **Smallest safe fix:** Use explicit message ID list instead of timestamp cursor.

### Bug 9: `syncFromServer` can overwrite newer local receipt states
- **Severity:** High
- **File:** `Frontend/src/services/MessageService.ts:160-211`
- **Function:** `syncFromServer`
- **Issue:** `saveMany` uses `upsertMany` which conflicts on `localId`. Server messages have `id` but `localId` might be empty or different. If server sends `id` without matching `localId`, upsert does nothing (onConflictDoNothing).
- **Scenario:** Server history sync misses messages because `localId` doesn't match.
- **Smallest safe fix:** Ensure `localId` is set to `id` for server-synced messages, or use server `id` as conflict target.

## 5. High-Priority Risks

### Risk 1: Kafka failure leaves DB inconsistent
- **File:** `Backend/src/kafka/producer.ts:22-48`
- **Issue:** No outbox pattern. Kafka publish failure throws, but the database transaction already succeeded.
- **Impact:** Message is saved to PostgreSQL but never emitted to other server instances.
- **Smallest safe fix:** Implement outbox pattern or at-least-once delivery guarantee with retry queue.

### Risk 2: Sync limit 200 hardcoded
- **File:** `Backend/src/services/message.service.ts:380-413`
- **Issue:** Users with >200 pending messages never fully delivered in one sync.
- **Impact:** Messages remain SENT indefinitely for users with many offline messages.
- **Smallest safe fix:** Implement cursor-based pagination with `lastId` or `lastCreatedAt`.

### Risk 3: No `conversationId` in `getPendingDeliveryMessages` response validation
- **File:** `Backend/src/services/message.service.ts:380-413`
- **Issue:** Backend could return messages from conversations user isn't part of.
- **Impact:** Privacy leak or incorrect ACK.
- **Smallest safe fix:** Join with conversation participants and filter.

### Risk 4: `eachBatchAutoResolve: true` in Kafka consumer
- **File:** `Backend/src/kafka/consumer.ts:36-48`
- **Issue:** Batch committed before all handlers finish. If handler crashes after commit, message is lost.
- **Impact:** Missed delivery/read receipts.
- **Smallest safe fix:** Use `eachBatch` with manual commit, or ensure handlers are idempotent.

## 6. Medium-Priority Improvements

1. Centralize shared event types between frontend and backend.
2. Split `bindCoreEvents` into smaller testable units.
3. Deduplicate `markMessagesDelivered` / `markAllMessagesDelivered` logic.
4. Add unique index on `id` column in SQLite schema.
5. Add startup validation for `JWT_SECRET`.
6. Lock down CORS origin in production.
7. Add rate limiting to socket auth middleware.
8. Add Zod validation for socket event payloads.
9. Remove duplicate `message:notification` path or document dual-emit behavior.
10. Wrap `MessageCard` in `React.memo` with stable props.

## 7. Security Review

| Area | Status | Notes |
|---|---|---|
| Socket auth | Good | JWT-based, validated on handshake |
| Event auth | Weak | Missing `receiverId` validation on delivery handler |
| CORS | Weak | `origin: '*'` with `credentials: true` |
| Message IDs | Good | UUIDs are non-guessable |
| Rate limiting | Partial | Global Express rate limiter exists, no per-socket limits |
| Content validation | Partial | Zod schemas for REST, none for socket events |
| JWT secret | Weak | Defaults to `'changeme'` if env var not set |

## 8. Scalability Review

| Area | Current | 10K Users | 100K Users |
|---|---|---|---|
| Kafka partitions | 1 default | Bottleneck for hot conversations | Must scale partitions |
| Redis adapter | Correct | Handles room routing fine | Handles room routing fine |
| Reconnect sync | limit=200, full scan | Acceptable with cursor | Needs cursor-based pagination |
| FlatList reload | reload on every message | Acceptable | Needs in-memory cache |
| DB queries | findMany + updateMany per ACK | Acceptable | Needs batching |

## 9. Code Quality Review

**Strengths:**
- Clean separation between SocketReceiver, useChat, MessageService, MessageStore
- TypeScript strict mode passing
- Idempotent ACK patterns with dedup sets

**Weaknesses:**
- Monolithic `bindCoreEvents` (400+ lines)
- Duplicated delivery logic (`markMessagesDelivered` vs `markAllMessagesDelivered`)
- No shared types between frontend and backend
- Some dead code from previous fixes

## 10. Missing Tests

- No unit tests for `MessageStore` queries
- No integration tests for Socket.IO event handlers
- No Kafka consumer idempotency tests
- No E2E tests for offline/reconnect scenarios
- No tests for `syncFromServer` status reconciliation

## 11. Recommended Roadmap

### Immediate (Pre-production)
1. Fix unread count queries (`getUnreadCount`, `getAllUnreadCounts`)
2. Fix `deliveredAckSet` race condition
3. Add `receiverId` validation to backend delivery handler
4. Add `conversationId` scoping to `markMessagesDelivered`
5. Move `syncPendingDelivery` to reconnect-only path
6. Clear `deliveredAckSet` on disconnect

### Next Sprint
1. Implement cursor-based pagination for reconnect sync
2. Add `conversationId` validation in `getPendingDeliveryMessages`
3. Add Kafka outbox pattern or at-least-once retry
4. Centralize event types
5. Add Zod validation for socket event payloads

### Later
1. Batch Kafka publishes for read receipts
2. Add presence tracking in Redis/session store
3. Implement message search indexing
4. Add E2E test suite for chat flows

### Nice-to-have
1. Message reactions
2. Typing indicators persistence
3. Read receipt cursors (read up to X)
4. Message forwarding UI

## 12. Clarifying Questions
1. Should `getUnreadCount` count messages in deleted conversations?
2. Is there a maximum message size limit enforced frontend AND backend?
3. Should `syncPendingDelivery` return conversation metadata for badge updates?
4. What is the expected maximum batch size for `markMessagesDelivered`?
5. Should presence events be stored in PostgreSQL for offline presence display?
6. Is the Redis adapter using pub/sub or keyspace notifications for presence?
7. What happens when a user is blocked — are messages still delivered?
8. Should edited/deleted messages while offline be reconciled on reconnect?
