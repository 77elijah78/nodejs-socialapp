# Android inline reply and conversation stacking

See [the v2 Android contract and frontend handoff](android-notification-replies.md) for the additive reply idempotency migration, per-device data-only opt-in, SDK source verification and device-testing gate. Existing alert delivery remains the default.

# Real-time and Android push messaging notifications

## Scope / audit
The existing system already persisted Message, independent MessageReceipt rows and
Kafka intents together in ReceiptOutbox. Kafka `chat.messages` consumers emit
`message:new` and `message:notification` to `user:<recipient>` rooms, distributed
by the Redis Socket.IO adapter. Social Activity/Notification is separate user-facing
social history and is retained unchanged. It is not duplicated for each message.

There was no push provider, token registry, device-aware app visibility, or durable
provider receipt/retry state. The old process-local online-user map cannot establish
whether a phone is foregrounded, backgrounded or terminated and is not used to
suppress push. This patch adds Expo push delivery and short-lived explicit visibility.
MessageReceipt and ReceiptOutbox schemas and receipt semantics are preserved.

## Architecture / event flow
1. Authenticate sender and validate active membership/recipients/reply target.
2. One PostgreSQL transaction creates the message, per-recipient MessageReceipt,
   existing ReceiptOutbox chat events, and a PushDelivery per currently registered
   enabled recipient device when PUSH_ENABLED=true. Unique(messageId,deviceId)
   prevents duplicate provider jobs. PushDelivery is a provider-state ledger/outbox,
   not another message/notification/receipt model. No jobs target the sender.
3. Existing outbox publisher retries Kafka publication. The consumer rehydrates the
   committed message, enforces actual receipt recipient and active membership, and
   emits a complete DTO. Legacy flat Kafka records are also rehydrated from DB.
4. New provider worker leases up to ten due jobs per iteration, rechecks membership,
   deletion, read state, user settings, token version and per-device viewing lease,
   then calls the actual Expo HTTPS Push API. No provider request runs inside a
   message transaction or Socket.IO handler. Provider/Kafka failures do not roll
   back a committed message, and Kafka retry cannot enqueue another provider job.
5. Expo forwards Android delivery to FCM using the app's FCM v1 credentials in EAS.
   The backend does NOT additionally send the same message via direct FCM.
6. Expo tickets are persisted, receipts polled after 15 minutes, and invalid tokens
   retired. Offline users recover actual messages/history/receipts through REST.

Push queue insertion is part of durable message persistence: apply migrations before
running the new code. A database failure in that transaction rolls the transaction
back, just like a failure writing the existing Kafka outbox. The isolation from
message success concerns external provider/network failures, not unavailable DBs.

## Exactly-once limitations (important)
Ordinary sequential/concurrent Kafka duplicates are suppressed with a per-message/
recipient Redis lease and an emitted marker (24h). Busy claims reject processing for
retry, rather than acknowledge an event that has not emitted yet. The marker is
written AFTER socket emission so a crash cannot pre-mark and permanently lose it.
If Redis is unavailable, delivery fails open. A crash after emit/before marker, Redis
loss, or a replay older than the marker can repeat a frame. Socket.IO sends to all
connected devices for the recipient; it is not an offline message queue. Clients
must upsert by stable message ID and reconcile on reconnect. Do not independently
append both message:new and the legacy message:notification banner as two messages.

No Expo API idempotency key can make provider acceptance and our DB commit atomic.
The conservative duplicate-avoidance policy is:
- Confirmed rate-limit rejection (HTTP 429/MessageRateExceeded): exponential backoff
  with jitter, at most five sends, using the same job ID/navigation data.
- Successful send ticket: NEVER blindly resend; poll its receipt instead.
- Timeout, 5xx, malformed successful response or expired SENDING lease: UNKNOWN,
  not an automatic resend. Expo may already have accepted it. An operator must
  review these; some may represent a missed push rather than a delivered one.
- InvalidCredentials/other permanent rejection: FAILED; fix configuration and
  review known-rejected jobs. Do not bulk retry UNKNOWN jobs.

This avoids automatic duplicate pushes from Kafka retries and ambiguous sends but
cannot promise exactly-once handset banners or guaranteed delivery. `data.notificationId`
is stable per message/device; use it for client deduplication. Android OS rendering
is not deduplicated automatically just because this field exists. Actual message
persistence and REST recovery are authoritative.

## Schema / migration
Migration: `20261101000000_message_push_delivery` (additive, no resets/backfills of
historical messages). Adds:
- User.messagePushEnabled (default true), pushPreviewsEnabled (default false).
- PushDevice: owner FK, globally unique installation deviceId and Expo token,
  tokenVersion, Android platform, enabled/invalidated state and timestamps. An invalid
  token is nulled and disabled; device metadata remains until logout/unregistration.
- PushDelivery: message/device cascading FKs, unique pair, token version, provider
  ticket, error code, attempts, receipt attempts, due time and fenced lease fields.
- PushDeliveryStatus: QUEUED, SENDING, RECEIPT_PENDING, RECEIPT_OK, FAILED,
  CANCELLED, UNKNOWN. Indexes cover due claims and status/time operations.
RECEIPT_OK means Expo's receipt succeeded, NOT that the phone displayed the message;
it never updates MessageReceipt delivery/read timestamps.

Registered devices at send time are targeted; newly registered devices do not get
retroactive push for old messages. QUEUED jobs retarget refreshed tokens. Old-ticket
errors are version-fenced and cannot invalidate the device's newer token. Unregister
cascades its jobs. Never log/export tokens; database access/backups require encryption
and appropriate access controls. Query bound values and raw Prisma error detail are
now omitted from DB logs to avoid exposing tokens.

## Backend configuration
```dotenv
PUSH_ENABLED=true
EXPO_PROJECT_ID=<your EAS project UUID>
EXPO_ACCESS_TOKEN=<secret Expo access token>
```
PUSH_ENABLED defaults false. Registration returns 503 while disabled; there are no
mock-success provider responses. EXPO_PROJECT_ID must match registration input.
EXPO_ACCESS_TOKEN is required at production startup; enable Expo enhanced push
security for that project and inject the token from a secret manager. This is NOT
a Firebase service-account JSON and NOT an Android device token. Never commit it.
Both Compose files pass these variables through. Existing DATABASE_URL, REDIS_URL,
Kafka and JWT settings continue to apply. Allow server HTTPS egress to
`https://exp.host/--/api/v2/push/send` and `/getReceipts` (10-second request timeout).
No extra Kafka topic is required. No direct FCM service-account file belongs on
this backend when using this Expo path.

For development Compose:
```sh
docker compose -f docker-compose.dev.yml up -d postgres redis zookeeper kafka
docker compose -f docker-compose.dev.yml build app
docker compose -f docker-compose.dev.yml run --rm --no-deps app npx prisma migrate deploy
docker compose -f docker-compose.dev.yml up -d --force-recreate app
```
Production Compose:
```sh
docker compose --profile tools build migrate
docker compose --profile tools run --rm migrate
docker compose build app
docker compose up -d app
```
Back up DB first; do not use migrate reset/down -v. Rebuild generated Prisma clients.
The dev file path must be the actual file you use (e.g. add its directory to -f).
These Docker commands are documented, NOT executed here; no Docker daemon is
available in the implementation environment. Preserve database and upload volumes.
A rolling deployment with old app instances will not enqueue push for messages they
create; deploy all message writers/workers together if uninterrupted push is required.

## Authenticated HTTP APIs
All routes are under `/api/v1/push`, require Bearer access JWT, and use existing
success/error envelopes. Rate limit: 30 requests/minute per IP plus the app limiter.

### POST /push/devices
```json
{
  "deviceId":"<UUID persisted per app installation>",
  "platform":"android",
  "projectId":"<EAS project UUID>",
  "token":"ExpoPushToken[<actual token>]"
}
```
Also accepts ExponentPushToken format. Native FCM tokens are not accepted here.
Returns data `{deviceId,platform,enabled,updatedAt}` (never the raw token). User ID
comes only from JWT; client-supplied ownership fields are stripped. Repeating the
same registration is idempotent. Token changes advance tokenVersion. An account may
have up to 20 registered installations. Device/token conflicts return 409 without
revealing another owner. Cross-account transfer requires the old account to
unregister first; knowing another token is not permission to overwrite its owner.
Normal authenticated registration assumes the app possesses its Expo token; this
is not hardware/device attestation.

### DELETE /push/devices/:deviceId
Call before logout/account switch. Idempotent `{unregistered:true}`; only the JWT
owner's matching installation can be removed. Unknown/foreign IDs do not modify
another user. If offline logout prevents this request, old-account push may continue
until unregistration/token invalidation/expiry handling; clear the binding before
account transfer and handle navigation by current account in the app. Unregistering
also cannot recall a request already in flight or a banner already displayed.

### GET /push/preferences
Data `{messagePushEnabled:true,pushPreviewsEnabled:false}`.

### PATCH /push/preferences
Supply either/both booleans. Opt-out is rechecked at dispatch. Preview opt-in is
required to expose sender/group labels and text on the lock screen. Defaults use
`New message` / `You have a new message`, including for groups. With previews on,
groups use sender + group name; media bodies are Sent a photo / Sent a video /
Sent a voice message / Sent a document / Shared a post / Shared a story. Push does
not contain media URLs, reply text or full message DTOs. Privacy changes cannot
recall a provider request that is already in flight or a banner already displayed.

## Socket and payload contracts
Existing authentication is handshake.auth.token (or Authorization header). The
server still auto-joins user:<JWT user ID> and validates active account state.

- `message:new`: full canonical message DTO, including sender (id/username/
  displayName/avatarUrl), conversationId, type/content, mediaUrl, thumbnailUrl,
  duration, fileName/fileMimeType/fileSize, sharedReference, repliedTo, timestamps,
  status/readByMe, plus existing messageId/timestamp aliases.
- `message:notification`: legacy banner event remains with the SAME complete DTO.
  Treat it as a banner hint, not a second message record.
- Send/reply ACKs and REST history remain unchanged. Read/delivery ACKs remain the
  only source of recipient message receipts; history fetching never marks read.
- `messages:sync` server event `{reason}` on connection/adapter recovery/Kafka group
  recovery: refetch inbox/active history/pending delivery using existing APIs.
- New client `conversation:visibility` event, optional function ACK:
```json
{"deviceId":"<installation UUID>","state":"foreground","conversationId":"<UUID>"}
```
Requires owned enabled device and active conversation membership. Emit every 15s
ONLY when app is active and the conversation is actually visible. ACK is
`{success:true,expiresInSeconds:45}` or `{success:false,error}`. On navigating away
emit foreground + conversationId:null; on AppState background emit
`{deviceId,state:"background"}`. Disconnect clears only that socket's lease, never
another newer socket's view. A missed disconnect expires within 45s. A crashed app
can therefore have a stale suppression window of up to 45s; no socket system can
prove instant background/termination. Redis failures fail open to push.

Suppression is per device, not user-online status: another registered device can
still receive push. Delivery is suppressed when the message is already read/hidden,
deleted, recipient departed, account disabled, token changed without a pending-job
retarget, or push preference is off. Opted-out users have no new jobs. Push begins
after a 3-second grace period and jobs older than 24h are cancelled.

Push navigation data (no private text):
```json
{
  "messageId":"<UUID>",
  "conversationId":"<UUID>",
  "conversationType":"private",
  "senderId":"<UUID>",
  "notificationType":"MESSAGE",
  "notificationId":"<stable provider-job UUID>"
}
```
conversationType is private or group. Authenticate and fetch the referenced
conversation before navigating; membership may have changed after dispatch.

## Expo / FCM Android build setup (frontend required)
1. Use a physical Android device and an EAS development/production build with
   expo-notifications installed. Do not rely on Android Expo Go remote push support.
   Install Expo-compatible expo-notifications, expo-device, expo-constants and a
   persistent UUID/storage solution (e.g. expo-crypto + expo-secure-store).
2. Set the Android applicationId/package to the Firebase Android app's package.
   Configure android.googleServicesFile for the matching google-services.json in
   your EAS build and the expo-notifications config plugin. google-services.json is
   client Firebase config, NOT the private service-account key.
3. In Firebase enable Cloud Messaging and create the least-privileged FCM v1
   service-account key needed for sending. Use `eas credentials -p android` to
   configure/upload Android FCM v1 push credentials for this EAS project. Store the
   private key with EAS/your secret manager, never in Git or API responses.
4. Link the app to the correct extra.eas.projectId. Enable Expo enhanced push
   security and configure EXPO_ACCESS_TOKEN on the backend. Rebuild/install the app
   after native/plugin/Firebase configuration changes.
5. Before requesting a token, create Android channel `messages` with HIGH
   importance. Request notifications permission (especially Android 13+), check it
   was granted, then call getExpoPushTokenAsync({projectId}). Register its `.data`
   value with the authenticated endpoint. Persist installation deviceId across
   sessions, but generate a new one on a genuinely new installation.
6. Re-register on login/start and token changes. Expo's token-change listener may
   provide a native device token: obtain a new Expo push token again rather than
   submitting a native FCM token to this endpoint. Unregister before logout.
7. Implement AppState/viewing heartbeats above, foreground notification behavior,
   and response listeners for taps. On cold start read the last notification
   response after auth/navigation are ready. Deduplicate response/job IDs, verify
   current account membership, then fetch/navigate by conversationId/messageId.

Minimal channel/token example (frontend illustration, not backend-executed code):
```ts
await Notifications.setNotificationChannelAsync('messages', {
  name: 'Messages', importance: Notifications.AndroidImportance.HIGH,
});
const permission = await Notifications.requestPermissionsAsync();
if (permission.status === 'granted') {
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  // POST { deviceId, projectId, platform: 'android', token } with current JWT.
}
```
Use a foreground handler appropriate for your Expo SDK to prevent duplicate banners
while the same chat is visible. These frontend changes are not present in this
backend repository and cannot be implemented/tested here.

## Worker status / operations
The worker drains before DB shutdown. Claims expire after 120 seconds; crashed
SENDING claims become UNKNOWN, receipt claims can safely retry. Receipts are polled
every 15 minutes, with missing/unavailable receipts becoming UNKNOWN after 24h.
Permanent token errors null the token and disable only the matching token version.
Provider receipt success does not assert actual handset delivery. Logs include
job/message IDs/status/error codes, not tokens, payload text or access credentials.

Useful private operator query:
```sql
SELECT status,error_code,count(*) FROM push_deliveries GROUP BY status,error_code;
```
Monitor QUEUED age, UNKNOWN, FAILED credential errors and provider quotas. Fixed
worker claim size is ten per second per process with concurrent bounded HTTP calls;
apply project-wide throttling if scaling many replicas near Expo quotas. Terminal
ledger rows currently require an operator retention policy; no automatic destructive
purge is added. Keep enough audit history to investigate ambiguous sends. Protect
push-token tables/backups and configure database-at-rest encryption.

## Tests executed / limits
- npm run build: passed.
- npm run db:validate:wasm: passed (24 models).
- npm run lint: passed with 0 errors and 7 existing warnings.
- npm test: 69 passed, including the existing messaging/notification regression suite.
- New tests cover all seven message types in private/groups, multiple devices,
  generic/opt-in previews, JWT token API/ownership/logout, refresh fencing, invalid
  token retirement, concurrent claims, Kafka retry/provider failure isolation,
  backoff/retry cap, ambiguous-send policy, foreground/background/expired-view/Redis
  fail-open behavior, visibility socket authorization, complete media/reply DTOs,
  concurrent Kafka dedup, sanitized registration errors and configuration guards.
- A filesystem-backed PGlite test closes/reopens DB and reloads service, checking
  persisted device registrations, push jobs and existing outbox state survive.
- HTTP, Prisma SQL and authenticated Socket.IO paths are real in tests; Expo HTTP,
  Redis transport and Kafka publication are explicit test doubles. No mock-success
  transport exists in production code. No live Expo/FCM push was sent here.
- No Android devices, EAS/FCM credentials, Docker daemon or live broker cluster were
  available. Physical background/terminated delivery, container-volume restart,
  real Redis/Kafka failover, notification permission/Doze behavior and app tap
  navigation require the manual matrix below. Dependency install still reports
  25 vulnerabilities; do not interpret this patch as a production certification.

## Two-device manual acceptance matrix
Use Android A (sender account A) and Android B (recipient B), same EAS project and
matching tokens, with PUSH_ENABLED=true. Keep provider responses/DB job IDs; never
paste tokens/credentials into shared logs.
1. Both foreground, B viewing A's DM: send text/image/video/voice. Expect one message
   record/event per device and no push to B's visible device; no sender incoming event.
2. B foreground on another screen: same messages should push; tap opens correct DM.
3. Background B using Home: repeat all types; verify banner/sound and navigation.
4. Swipe B's app away (terminated, NOT Settings Force stop): repeat; tap should cold
   launch/authenticate/navigate. Android force-stop may block FCM until app relaunch,
   which the backend cannot override. Test Android 13+ permission denial separately.
5. Create a group with A/B, repeat visible/other-screen/background/terminated cases;
   enable B previews to verify sender/group labels and media preview text, then
   disable previews and confirm no private content/names on lock screen.
6. To test multiple devices with only two phones, sign B into both A/B and send as
   account A from a separate API/web client. Confirm a visible device is suppressed
   while the other receives push. Restore A/B accounts afterward.
7. Refresh/re-register token; verify QUEUED jobs retarget and stale old receipt
   errors cannot retire the new token. Logout/unregister, then send; no new push.
8. Disconnect sockets, restart backend/container without deleting volumes, then send
   and reconnect: token/jobs persist, REST history recovers messages, push does not
   depend on Socket.IO. Restart Kafka and Redis independently; check outbox recovery
   and fail-open suppression. Test rate limits and credential errors in staging.
9. Inspect Expo receipts after 15 minutes. RECEIPT_OK is provider-level only; confirm
   actual screen behavior on both phones before declaring production readiness.

## Files for this change
- prisma/schema.prisma; prisma/migrations/20261101000000_message_push_delivery/migration.sql
- src/config/push.ts; src/config/redis.ts; src/config/database.ts
- src/services/push-device.service.ts; push-delivery.service.ts; expo-push.provider.ts;
  delivery-state.service.ts; message.service.ts
- src/routes/push.routes.ts; src/routes/index.ts
- src/socket/push.handler.ts; src/socket/index.ts; src/kafka/consumer.ts; src/index.ts
- .env.example; docker-compose.yml; docker-compose.dev.yml
- test/receipts.test.mjs; docs/message-push.md
