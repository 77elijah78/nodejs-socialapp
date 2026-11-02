# Android notification reply and conversation stacking — frontend handoff

## Status and coordination

Repository: `77elijah78/nodejs-socialapp` (https://github.com/77elijah78/nodejs-socialapp)

Branch: `arena/dabc652a-nodejs-socialapp`. The implementation commit SHA is supplied with the final handoff (or run `git log -1 --format=%H` on that branch).

The frontend agent's plan, relayed by the user, is Expo Notifications categories/text-input actions plus a background reply task. Its renderer is **not yet finalized or implemented**. This backend supplies a compatible, versioned API and an **opt-in data-only transport candidate**, not a certification of the installed Android SDK or end-to-end delivery. Keep existing devices on `expo-alert` until the frontend verifies the renderer and background task on physical Android devices. No live database, deployment or PR merge was performed.

## Audit and delivery decision

Preserved the existing `messageService.replyMessage → sendMessage` flow, authenticated REST routes, canonical DTOs, `MessageReceipt`, transactional `ReceiptOutbox`, Kafka/Socket.IO fanout, Expo HTTP send/receipt provider, leased push worker, token ownership/version fencing, preview/opt-out preferences and per-device visibility leases. No competing message store, direct FCM credential path or automatic read operation was added.

Source inspection on 2026-11-02:

* [Expo server SDK source, commit 1072018](https://github.com/expo/expo-server-sdk-node/blob/10720180253503fb295b322fcc3d6aa75bb08c76/src/ExpoClient.ts): `ExpoPushMessage` supports optional title/body/sound, data, categoryId, priority/TTL, and `_contentAvailable` (now a deprecated alias for `contentAvailable`). It has **no documented Android `groupKey` field**. `tag`/collapse IDs replace/coalesce notifications; they are not conversation stacking. This backend does not set them.
* [Expo Android notification builder, commit 158c831](https://github.com/expo/expo/blob/158c83168cfce34226af59a3d14a1f92990a1df0/packages/expo-notifications/android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt): builds text-input actions using Android `RemoteInput`, loads previously persisted categories, and applies `NotificationCompat.Builder.setGroup` when content supplies a group.
* [Handling delegate at the same revision](https://github.com/expo/expo/blob/158c83168cfce34226af59a3d14a1f92990a1df0/packages/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/ExpoHandlingDelegate.kt): explicitly distinguishes background data-only delivery and task-manager handling; notifications carrying display content can take another rendering path. It dispatches custom notification actions to background tasks. This does not demonstrate behavior of the user's installed version.
* [Firebase messaging delegate](https://github.com/expo/expo/blob/158c83168cfce34226af59a3d14a1f92990a1df0/packages/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/FirebaseMessagingDelegate.kt): receives remote messages and runs registered task-manager tasks.
* [Notification data parser](https://github.com/expo/expo/blob/158c83168cfce34226af59a3d14a1f92990a1df0/packages/expo-notifications/android/src/main/java/expo/modules/notifications/notifications/model/NotificationData.kt) and [JS types](https://github.com/expo/expo/blob/158c83168cfce34226af59a3d14a1f92990a1df0/packages/expo-notifications/src/Notifications.types.ts): current upstream uses `threadIdentifier` for a locally rendered Android group key. Do **not** assume an older installed SDK implements this or that an Expo remote `threadId` is the Android equivalent.

**Mechanisms:**

1. `expo-alert` (default): unchanged Expo alert → FCM/Android display path, with additive v2 data. No promise of inline actions or custom conversation stacking. Merely adding `categoryId` would not fix FCM auto-rendering.
2. `android-data-v2` (explicit device opt-in): same Expo Push HTTP API/FCM transport, **no top-level title/body/sound/channel/category**, high priority, TTL 3600, `_contentAvailable: true`; display content is nested inside custom data. A registered frontend background task or native module must receive it and render one local notification with the supplied category and group key. This moves rendering responsibility to the client; it is **not** an always-delivered native renderer implemented by this backend. No fallback alert is also sent, which would cause duplicates.

We verified source support and the actual outbound HTTP JSON in tests with a provider boundary double. We did **not** observe Expo's resulting FCM envelope or any physical Android rendering. The closed-source Expo gateway, pinned frontend package/build, native task execution and OS behavior still require device verification. If the installed Expo SDK cannot apply both actions and group keys, implement/upgrade a native renderer before opting in. A direct FCM data transport, if subsequently chosen, needs a separate reviewed implementation; do not silently send native FCM tokens to the Expo endpoint.

## Device registration and existing lifecycle

All paths are relative to `/api/v1`. Authenticate with the **recipient account's login access JWT**, never an Expo provider secret.

`POST /push/devices`

```json
{
  "deviceId": "<stable installation UUID>",
  "platform": "android",
  "projectId": "<matching EAS project UUID>",
  "token": "ExpoPushToken[<real installed-device token>]",
  "deliveryMode": "android-data-v2"
}
```

`deliveryMode` is optional and accepts only `expo-alert` or `android-data-v2`. Omission explicitly selects `expo-alert`, including on re-registration/token refresh. A validated new frontend must pass its chosen mode on **every** registration/refresh. Older apps revert safely to the old path. Selection is per device, not account; one account can have old and new installations simultaneously. Already leased/in-flight pushes cannot be recalled when modes change. QUEUED jobs use the mode current at processing time.

200 response:

```json
{
  "success": true,
  "message": "Device registered",
  "data": {
    "deviceId": "<installation UUID>",
    "platform": "android",
    "deliveryMode": "android-data-v2",
    "enabled": true,
    "updatedAt": "<ISO timestamp>"
  }
}
```

No token returned. Existing 20-installation limit, EAS project check, cross-account/token ownership conflicts, invalid-token cleanup and token-version fencing remain. `DELETE /push/devices/:deviceId` is owner-bound logout/unregister. Unregister before switching accounts; clear local notifications, rendering dedup state and queued reply actions for that account. Do not reuse old actions with a new account's JWT. Token rotation on the **same installation** does not invalidate already received notification IDs.

Existing `GET /push/preferences` and `PATCH /push/preferences` accept/return `{messagePushEnabled:boolean,pushPreviewsEnabled:boolean}`. Preview defaults remain false. Opt-out controls incoming push, not the ability to send a user-requested reply.

## Exact outbound Expo push contract v2

Angle-bracket values below are descriptive placeholders, not usable credentials or literal JSON contract values. IDs are UUID strings, TTL is seconds. `notificationId` is the durable per-message/per-device delivery job UUID, stable across safe delivery retries, **not** a reply action ID or provider ticket. `deviceId` is the public installation UUID, not the internal device-row ID.

Data-only mode:

```json
{
  "to": "ExpoPushToken[<device token>]",
  "priority": "high",
  "ttl": 3600,
  "_contentAvailable": true,
  "data": {
    "contractVersion": 2,
    "notificationType": "MESSAGE",
    "deliveryMode": "android-data-v2",
    "notificationId": "<delivery job UUID>",
    "recipientUserId": "<recipient account UUID>",
    "deviceId": "<installation UUID>",
    "messageId": "<incoming message UUID>",
    "conversationId": "<conversation UUID>",
    "conversationType": "private",
    "senderId": "<original sender UUID>",
    "groupKey": "socialapp:v2:<recipient account UUID>:<conversation UUID>",
    "categoryIdentifier": "MESSAGE_REPLY_V2",
    "display": {
      "title": "New message",
      "body": "You have a new message",
      "channelId": "messages"
    }
  }
}
```

`conversationType` is `private | group`. Same conversation/account has the same `groupKey` on all devices; different conversations or recipient accounts have different keys. Local child notification identity must use `notificationId` (or an equivalently account-scoped stable ID), **not** `groupKey`: replacing one child per conversation is not stacking. A renderer must manage summary notifications separately, group children by `groupKey`, and not mix accounts.

Default alert mode has exactly these top-level fields:

```json
{
  "to": "ExpoPushToken[<device token>]",
  "title": "New message",
  "body": "You have a new message",
  "sound": "default",
  "channelId": "messages",
  "priority": "high",
  "ttl": 3600,
  "data": {
    "contractVersion": 2,
    "notificationType": "MESSAGE",
    "deliveryMode": "expo-alert",
    "notificationId": "<delivery job UUID>",
    "recipientUserId": "<recipient account UUID>",
    "deviceId": "<installation UUID>",
    "messageId": "<incoming message UUID>",
    "conversationId": "<conversation UUID>",
    "conversationType": "private",
    "senderId": "<original sender UUID>",
    "groupKey": "socialapp:v2:<recipient account UUID>:<conversation UUID>",
    "categoryIdentifier": "MESSAGE_REPLY_V2"
  }
}
```

Preview-on display rules are unchanged: private title is sender display name/username; group title is `sender · group name` (fallback `Group conversation`), truncated to 128 characters. Body is text up to 160 characters or `Sent a photo`, `Sent a video`, `Sent a voice message`, `Sent a document`, `Shared a post`, `Shared a story`. Preview-off content is always generic in either mode, including nested data; no media URLs/full message bodies are included. Client must not fetch content just to defeat this privacy choice. The remaining IDs are routing metadata, not authorization proofs.

Worker still rechecks preferences, account state, enabled/current token version, active membership, original message deletion, per-user hiding/read state and visibility before send. Sender devices are excluded. Visibility stays per installation: foreground conversation heartbeat 15 seconds, TTL 45 seconds; background clears it. Sending a reply does not renew a lease or mark the original read. Provider ticket/receipt success is not display/read confirmation. UNKNOWN/ambiguous provider-send behavior remains unchanged; no blind duplicate resend.

## Exact idempotent reply API

Reuse the existing endpoint:

`POST /api/v1/messages/conversations/:conversationId/reply`

Headers:

```http
Authorization: Bearer <current login access JWT for recipientUserId>
Content-Type: application/json
```

Body (notification action):

```json
{
  "content": "The user's typed response",
  "type": "TEXT",
  "repliedToId": "<messageId from received notification>",
  "notificationAction": {
    "contractVersion": 2,
    "actionId": "<client-generated UUID, persisted before first attempt>",
    "recipientUserId": "<recipientUserId from received notification>",
    "deviceId": "<deviceId from received notification>",
    "notificationId": "<notificationId from received notification>"
  }
}
```

* `:conversationId` comes from the notification; no client conversation-type routing switch is required.
* Text must contain non-whitespace and be at most 5000 characters. `type` may be omitted (TEXT default). No media/attachment/duration/shared-reference fields in notification actions. Typed text is not trimmed or otherwise rewritten before saving.
* Omit `receiverId`: the server derives **all current active recipients** for private/group conversations. If supplied, existing validation requires a current other participant; it never narrows group fanout. Retries must consistently omit or retain it.
* `notificationAction` is optional only for backward compatibility with existing ordinary replies. A frontend notification handler **must always include it**. Missing it uses the old non-idempotent API; there is no automatic ID inference. Notification reply handlers should use REST, not depend on an existing Socket.IO session.
* Server verifies JWT account equals `recipientUserId`, installation is still owned/enabled/registered by that account, notification job belongs to that installation/account and targets this incoming message/conversation, and sender is still an active member. New actions cannot reply to globally deleted or locally hidden originals.
* Unique key is `(authenticated userId, actionId)`. A canonical SHA-256 request fingerprint binds exact text, conversation/target, optional receiver and all action metadata (independent of JSON key order). Reusing the action with different content/device/notification/target fails with 409. Different accounts may independently generate the same UUID. Separate legitimate submissions need fresh action UUIDs; notificationId alone must not be used as the action UUID.

**Success:** HTTP **201** on both first commit and replay, preserving existing response compatibility:

```text
{ success: true, message: "Reply sent", data: MessageDTO }
```

`MessageDTO` is the existing message shape, not a new envelope: all Message scalar fields plus `sender:{id,username,displayName,avatarUrl}`, `repliedTo:MessageWithSender|null`, `isGroup:boolean`, `readByMe:false`. Dates are ISO strings, nullable fields remain null. In particular `data.id`, `data.conversationId`, `data.senderId`, `data.repliedToId`, `data.content`, `data.type`, `data.createdAt` identify the saved reply. First and repeated successful requests return the **same `data.id`**. A replay hydrates the current saved DTO (e.g. an edit may change content), not an immutable cached HTTP response; no second message/receipt/outbox/push intent is created. There is no `replayed` field or read acknowledgement.

Failures use existing `{success:false,message:string,errors?:string[]}`:

| HTTP | Meaning / client handling |
|---|---|
| 400 | Invalid UUID/version/text/target or no eligible recipient. Stop automatic retries. |
| 401 | Missing/invalid/expired login JWT. Refresh only the matching account session; retry the identical action. Never switch to another account's token. |
| 403 | Wrong account/device/job binding, logout, deleted conversation or removed membership. Stop and clear/reconcile the local notification. |
| 409 | Same action UUID used for a different request. Do not generate a new UUID to bypass this error; reconcile the pending action. |
| 410 | Previously committed reply has since been deleted; action tombstone prevents recreation. Stop retries. |
| 5xx / timeout / connection loss | Outcome may be ambiguous; retry the **same UUID and identical request** with bounded backoff. Do not fall back to a non-idempotent message send. |

Authorization checks still apply on replay. Hard-deleted originals/conversations may result in target/member errors before a replay can be returned; never recreate a conversation automatically. Unregister removes its delivery jobs, so a later reinstall cannot use old notifications as new reply authorization. A still-registered installation with a rotated token can reply to its earlier notification.

### Transactional guarantees

Notification sends serialize on the account row with `FOR NO KEY UPDATE` (compatible with FK key-share checks); the composite primary key additionally enforces uniqueness. Owned device and participant rows are locked during validation/persistence so logout/rotation/removal orders against the send. Current recipients are derived inside the transaction, not from stale push data. For new actions, the original message is locked against concurrent delete/edit.

The reply, per-recipient `MessageReceipt`, existing publication intents, per-device push intents and action mapping commit or roll back together. Publisher/provider failure cannot undo a committed reply. Retrying after a timeout finds the action mapping rather than sending again. The action ledger stores only a fingerprint and message ID, not another copy of message content. Tombstones intentionally have **no message/conversation foreign key**, so deleting those entities cannot forget a committed action. Do not purge this table without defining an explicit end to the retry guarantee. Account hard deletion cascades its action entries.

These are database-enforced mechanisms, not a claim of exactly-once notification display. Multi-process native PostgreSQL lock contention/load testing remains an operational validation step.

## Required frontend work and acceptance gate

1. Confirm actual Expo SDK, `expo-notifications`, `expo-task-manager`, target SDK, build type and Android/OEM versions. Supply these and device findings back to the backend agent. Source inspected above is upstream main, **not evidence of the installed build**.
2. Create channel `messages` and notification permission flow. Register category `MESSAGE_REPLY_V2` before notifications can arrive, with a text-input action (recommended action identifier `REPLY_MESSAGE_V2`) and no foreground launch. Persist category registration for cold starts. Configure the background task at module scope and register it per the pinned SDK requirements.
3. For data-only receipt, decode the actual installed SDK's task payload. Expo/FCM task wrappers may serialize custom data inside a string/body envelope; capture only safe field names/types during verification. Validate version/type/account/device before display or action processing. Unknown versions: no reply send; safely sync/open the matching account.
4. Choose exactly one renderer. Verify that the installed Expo local scheduling path applies **both** persisted category/text input and Android grouping. At audited upstream main, local `threadIdentifier = data.groupKey` is mapped to Android grouping, but this must be checked against the installed version. Otherwise use a native module implementing `RemoteInput`, `NotificationCompat.setGroup`, unique child IDs and group summaries. Do not render an FCM auto-alert again in JavaScript. Do not treat Expo iOS `threadId` or FCM collapse/tag as a group key.
5. Opt in using `deliveryMode:"android-data-v2"` only after validation. Display only `data.display`; use the stable notificationId for duplicate suppression across foreground/background/native callbacks. Render group summaries without copying sensitive content when previews are off. A summary action must reference a specific valid child message/job, not arbitrary conversation metadata.
6. Persist a new action UUID **once per submitted user reply** alongside the original complete request before starting network I/O. Foreground and task callbacks must converge on that pending record. Retry the same record after process restart/timeout; fresh edits/new submissions get a new UUID. Securely store account-specific auth/pending text and never log them. Do not mark read as a side effect of send.
7. Match recipientUserId and installation UUID against local auth/registration; never send from whichever account happens to be logged in. If secure credentials are unavailable in the background, keep the action pending for authenticated recovery rather than sending unauthenticated or opening the wrong session.
8. Clear notifications/pending actions on logout, account switch and membership/conversation deletion discovered during sync. Backend cannot recall pushes already accepted/in flight/displayed. Continue normal REST reconciliation after dropped data pushes.

**Physical-device acceptance (not run here):** two Android devices/accounts; private and group messages; foreground, Home/background, process killed (separate from Android Force stop); two conversations produce distinct stacks; repeated messages produce multiple children within one stack; correct summaries; inline text input without opening foreground; deliberately lose the first reply response and retry; multiple devices and token rotation; logout/account switch with stale notifications; removed members/deleted conversations; previews disabled and incoming opt-out; permission/channel denied; offline/Doze/OEM restrictions and cold-start credential restoration. Wait out any stale 45-second visibility lease before clean background delivery tests. Inspect the real received remote message to prove no FCM notification auto-rendering in data-only mode. Android Force stop and OS restrictions can prevent delivery/tasks; high priority is not a guarantee. Do not announce terminated-app support until this passes for the actual build.

## Migration and deployment — approval required, not executed

New additive migration: `prisma/migrations/20261102000000_notification_reply_contract/migration.sql`.

* Adds `push_devices.delivery_mode` with `expo-alert` default and allowed-value CHECK; existing devices/tokens/versions remain untouched.
* Adds `notification_reply_actions` with composite PK and account FK. No reset, message backfill, token rewrite or old-message push.
* Requires the earlier `20261101000000_message_push_delivery` migration and all predecessors.

After separate approval, back up the target database, generate/build the new client/image, apply migrations once with the approved target `DATABASE_URL`, then roll out backend instances **before** upgraded frontends:

```sh
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy
# Restart/roll out the approved app image using your actual Compose/orchestrator configuration.
```

Use migration deploy, not dev/reset/db push. The user's actual local Compose path is `docker/docker-compose.dev.yml`; do not substitute a nonexistent root file. Container workflows should execute `prisma migrate deploy` from the newly built image against the intended DB before starting new code. No new secrets/env vars are required; existing PUSH_ENABLED, matching EAS project, Expo access secret and FCM v1 credentials still apply. To roll back rendering per device, re-register with `deliveryMode:"expo-alert"` (or omit the field). Keep additive schema on backend rollback; do not drop action tombstones. Older backend binaries cannot interpret data-only registrations; coordinate frontend fallback before rolling back code.

## Validation actually run

* `npm run build`: passed.
* `npm run db:validate:wasm`: passed, **25 models**.
* `npm test`: **79 passed, 0 failed/skipped**. Existing 69 retained; 10 new tests, plus updated wire-shape and persisted-reopen assertions.
* `npm run lint`: **0 errors, 7 existing warnings**.
* `git diff --check`: passed.

Tests use actual Prisma transactions/SQL through PGlite PostgreSQL WASM, authenticated HTTP and existing Socket.IO tests. They cover duplicate private/group requests, composite unique constraint, injected rollback, post-commit lost connection **and actual HTTP timeout**, replay without duplicate message/outbox/push, ownership/version/notification binding, multiple devices/accounts, removal/logout/rotation, deleted originals/replies/conversations, grouping separation and same-conversation stability, nested privacy, opt-out, alert fallback, compatible migration defaults and disk close/reopen action-ledger persistence. Existing tests continue to cover visibility suppression, invalid tokens, worker leases/retries, receipts and provider failure isolation.

Provider HTTP is explicitly doubled; Redis/Kafka are explicit boundary doubles. PGlite is not a multi-connection native PostgreSQL concurrency/load test. No Expo gateway request, Android/FCM device delivery, native rendering, terminated-app reply, Docker deployment, real Redis/Kafka cluster or live migration was tested. The frontend rendering decision remains an open verification gate, not a completed claim.

## Changed file inventory

* `prisma/schema.prisma`, new migration: mode and durable action ledger.
* `src/middlewares/schemas.ts`: backward-compatible notification action validation on the existing reply endpoint.
* `src/services/message.service.ts`: transactional action fingerprint/unique mapping, membership/device locking and reuse of normal persistence/outboxes.
* `src/routes/push.routes.ts`, `src/services/push-device.service.ts`: per-installation delivery capability registration; ownership/lifecycle preserved.
* `src/services/expo-push.provider.ts`, `src/services/push-delivery.service.ts`: typed v2 identifiers, privacy-preserving display and opt-in data-only wire shape.
* `src/middlewares/errorHandler.ts`, `src/socket/chat.handler.ts`, `src/services/receipt-outbox.service.ts`, `src/kafka/producer.ts`, `src/kafka/consumer.ts`: do not log raw runtime/Prisma/transport errors along reply/send/publication paths; unexpected HTTP errors stay generic even outside production.
* `test/receipts.test.mjs`: compatibility, replay, timeout, authorization, privacy/grouping/migration/persistence checks.
* This handoff, linked from `docs/message-push.md`.
