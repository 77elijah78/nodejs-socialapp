# Reliable backend receipts

Paired frontend: https://github.com/77elijah78/socialApp/pull/2 (`278640c`, `75f63d5`).
This is a fresh implementation against backend `002e337`; the previously prepared patch/commit was not available. No frontend files were changed.

## Root causes and contract

- History GET used to advance `lastReadAt` and produce a read event based on a page boundary, not actual visibility. It is now read-only, ordered by `(createdAt DESC, id DESC)` with same-conversation cursor validation.
- Read ACKs used an `isRead=false` lookup and silently returned on retries; they lacked transactionality and only notified the sender. `message:read` now requires UUID `{conversationId,messageId}`, derives the reader from the authenticated socket, checks active membership, recipient snapshot and non-deleted target, and rejects self/foreign reads. It neither advances `lastReadAt` nor reads other messages.
- The recipient's first `MessageReceipt.readAt` is preserved. A message-row lock serializes duplicate reads. The receipt, compatible aggregate `Message.status=READ/isRead=true`, and publication intent commit together. Every valid retry creates a fresh reconfirmation intent using the original timestamp.
- Kafka emits the unchanged `{conversationId,messageId,userId,readAt}` contract to the union of `user:<senderId>` and `user:<actualReaderId>`. Socket callback success means DB commit, **not** delivery confirmation; the reader's `message:read` event confirms its durable client queue.
- Delivery UPDATE predicates require `SENT/SENDING` and `isRead=false`, even after a stale SELECT. Per-member delivery uses null-read/null-delivery predicates. A delivery event may arrive after a read event; clients must retain monotonic state.
- Outgoing group READ means **any other recipient**. Each message has one receipt per recipient; one member never reads another's receipt. History/pending DTOs expose `isGroup/readByMe`; conversation unread counts and pending delivery use individual receipts. Sends/replies/forwards validate recipients before creation, create one canonical message with nested receipts, and fan out per-recipient events using the existing Kafka topic and Socket.IO server.
- Explicit REST `POST /conversations/:id/read` remains a separate intentional bulk action. It uses per-message committed reads, not a visibility shortcut or a `lastReadAt` watermark. Bulk operations may partially complete if an item fails; retries safely complete remaining items.

## Durable publication and recovery

`receipt_outbox` is PostgreSQL-backed. Healthy reads attempt Kafka publication immediately after commit, with no artificial visibility delay. Failed publication remains persisted with exponential operational retry backoff capped at 60 seconds. Each backend process also starts a serial one-second recovery worker.

Claims are a single `UPDATE ... SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50`, with a random fencing token and a 60-second lease. Only the token owner deletes/reschedules an intent. Expired leases are reclaimable after crashes. A slow publisher exceeding its lease can cause duplicates, never loss: consumers/clients must handle immutable receipt events idempotently. Kafka success followed by process failure before deletion intentionally republishes at least once.

Shutdown closes socket/HTTP intake and awaits active worker publication before disconnecting Kafka/Prisma. Kafka consumer processing exceptions are rethrown instead of silently resolving offsets. Poison events now require operator investigation; there is no new dead-letter system.

Redis pub/sub reconnection readiness and Kafka consumer group rejoin emit local `receipts:resync` to still-connected sockets. Each affected backend signals its own sockets without relying on broken cross-pod Redis delivery. The paired client then reconciles outgoing statuses and replays unconfirmed visible reads.

`POST /api/v1/messages/receipts/sync` is authenticated, validates at most 200 UUIDs, and returns `{data:[{messageId,conversationId,status}]}` (plus existing response-envelope fields). It selects exact requested IDs, including old messages, scoped to the authenticated sender and active conversation membership. It does not update receipts, messages, participants or publish events. The existing authentication middleware's account-activity bookkeeping remains unchanged.

## Migration, backfill and deployment order

**Do not deploy the paired client before the migration and backend API. No migration or deployment was run against production in this session.**

1. Back up PostgreSQL; stage-test a production-sized copy and estimate table/index/backfill time. Coordinate a maintenance/drain window: stop old writers/consumers and old history-triggered false-read producers. Existing CI deploys on main; review deployment gating before merging.
2. Apply additive `20261030000000_reliable_message_receipts` with the normal production `prisma migrate deploy` process. It creates receipt/outbox tables and indexes; it does not drop, replace or rewrite message history. Regenerate the production Prisma client with the normal native-engine configuration.
3. Backfill creates recipient rows from existing conversation membership. DMs with aggregate READ use `updated_at` as an **approximation**, because no historical per-message read timestamp exists. DM delivery uses `delivered_at` or `updated_at`. Group personal states remain unknown/unread; an aggregate group READ cannot identify which member read. Existing aggregate fields are retained for compatibility. Migration cannot repair historical falsely reported reads in old client caches.
4. Drain-before-backfill matters: old code creates no receipt rows. If old writers ran after backfill, stop them and rerun **only the migration's final INSERT ... SELECT ... ON CONFLICT DO NOTHING** before serving new traffic. Do not rerun its CREATE TABLE statements. The idempotent INSERT preserves existing per-member timestamps. Current membership cannot reconstruct historic removed/new group recipients exactly; stage/audit this legacy approximation.
5. Deploy the backend including outbox workers, API and receipt consumer. Ensure old Kafka history-read events have drained; they are not trustworthy visibility acknowledgments. Check that table/index/client versions match. Verify HTTP authentication, exact-ID recovery, reader echoes, two-account visibility and a three-member group in staging.
6. Only then deploy frontend PR #2. Validate real mobile background/foreground and interrupted-network recovery. Monitor failed publication logs, outbox row count/attempts and leases, consumer lag/restarts, Redis recovery, DB locks and receipt-query latency. During a sustained outage the outbox can grow; provision storage/alerts instead of dropping intents.

## Rollback

Stop/drain new backend writers and publishers before changing code. Preserve receipt/outbox tables and pending rows; an application rollback does not require destructive schema rollback. Do not delete queued intents. Resume them with the upgraded publisher after recovery.

The old backend lacks the required sync/reader-echo contract and can falsely mark history read. Roll back/pause the paired client together or keep the upgraded receipt API available. Messages/legacy aggregate fields remain compatible, but old writes during rollback require the idempotent missing-receipt backfill before re-upgrade. A destructive down migration would lose durable confirmations and individual read timestamps and is intentionally not supplied.

## Verification and limitations

Commands:

- `npm run db:generate`: native-engine host `binaries.prisma.sh` is blocked in this sandbox; normal generation was attempted and failed honestly.
- Local-only fallback: `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true PRISMA_QUERY_ENGINE_LIBRARY=/bin/true npx prisma generate --no-engine` generated the build's type client. No generated clients or engine overrides are committed. Production schema/deployment engine configuration is unchanged.
- `npm run db:validate:wasm`: validates all 20 models with Prisma's WASM schema parser.
- `npm run build`: passes.
- `npm run lint`: passes, 0 errors / 12 existing unused-variable/stale-directive warnings exposed by the newly installed recommended TypeScript ESLint configuration. Existing `any`/`Function` boundary types remain allowed; this is not a whole-application type-safety cleanup.
- `npm test`: **15 passing integration tests**, with all committed SQL migrations executed in PostgreSQL/WASM, a temporary engineType=client Prisma test client, an adapted pg transport, actual Express/JWT middleware, and real Socket.IO clients. Identity for socket tests and Kafka publication are adapted. Tests include read-only history/tied cursors, duplicate timestamps, rejection cases, group isolation, stale-SELECT delivery interleaving, rollback injection, Kafka failure/backoff/expired leases, bounded overlapping claims, shutdown draining, exact old-ID recovery/auth/limits, consumer rejection and legacy backfill preservation.
- `git diff --check`: passes. CI now runs schema generation/validation and these tests, not just build/lint.

This is **not** a physical-device test, native PostgreSQL multi-process stress test, live Kafka/Redis cluster test, production migration rehearsal or deployment sign-off. The WASM transport uses one database connection; the stale-SELECT interleaving and overlapping publisher tests exercise the intended failure boundaries but do not replace native concurrent load/failover testing. Infrastructure recovery hooks still need live-cluster staging checks.

Message send publication/delivery events retain the existing non-outbox path; this upgrade's durable outbox covers read receipts only. Ambiguous send retries still lack a client/server nonce. This does not claim exactly-once sends. Per-conversation unread counts currently add one count query per conversation; optimize based on measured production load. Existing dependency audit findings remain (15 total: 3 moderate, 11 high, 1 critical after adding test tooling); no unrelated dependency-major upgrade was attempted.
