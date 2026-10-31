# Production-test audit and deployment guide

## Status
Implemented and tested backend changes on `arena/dabc652a-nodejs-socialapp`, not
on main. This is **not a production certification**. No production DB, physical
phone, Docker daemon, live Kafka broker or Redis cluster was available for these
tests. Do the deployment/device gates below before inviting real users.

## Confirmed causes
1. Media URLs defaulted to localhost in service, Compose and environment example.
   A phone interprets localhost as itself. Static serving and a named upload volume
   already existed; neither was missing. New production startup requires an explicit
   public HTTPS media origin (legacy BASE_URL remains a fallback).
2. Uploaded filenames used client extensions, MIME was trusted without content
   inspection, the mixed endpoint accepted images/audio up to 200MB, and audio WebM
   responses were forcibly labeled video. Canonical extensions, bounded header
   inspection, image decoding/pixel limits and per-category size validation now
   apply. The registry supplies the stored MIME on reads.
3. Static uploads were public, including private messages. Reads now authorize
   against owning uploader or current live post/avatar/story/message references.
4. Optional sharp was not a dependency, thumbnail MIME/extension could disagree,
   and optional WebP rewriting changed primary URL without corresponding file
   metadata. Sharp is now installed; the original stays the primary URL, and a
   registered JPEG thumbnail uses a .jpg filename and source reference.
5. Post create required text even for media posts and did not default image arrays.
   Media-only posts now work. Upload-backed metadata is populated when omitted;
   the same mediaMetadata/imageUrls/videoUrl selection is used in create, feed,
   profile, detail, bookmarks and activity post references.
6. Comments had create-only routes, no retry keys, unvalidated parent IDs and counts
   that included deleted comments. Added retrieval, ordering/pagination, deletion,
   author/post IDs, retry key uniqueness, parent validation and live-only counts.
7. Notifications existed but had no Activity API. Like/comment/follow persistence
   was separate from activity writes and lacked durable publication. New activity
   records and existing outbox intents commit in the interaction transaction.
8. Bookmarked/liked listings included deleted posts. Both now filter them, and
   ordering has deterministic tie breakers. Public profile responses exposed email;
   that field is no longer returned.
9. See messaging-reliability.md for the reply/deletion/outbox audit preserved here.

## Media architecture and privacy
The intended deployment is **one application host**, with persistent named volume
`uploads_data:/app/uploads`. The API disk-streams multipart files; videos are not
buffered in memory. Register files in MediaAsset (owner, key, URL, MIME, byte size,
sourceUrl for thumbnails). A media URL is stable, not a temporary signed URL.

- PUBLIC_MEDIA_BASE_URL=https://api.example.com/uploads (no trailing slash required).
- UPLOADS_PATH=/app/uploads (Compose default).
- BASE_URL is a backwards-compatible origin fallback; prefer the explicit variable.
- JWT_SECRET must be 32+ characters and not a known placeholder in production.
- Set POSTGRES_PASSWORD, CORS_ORIGIN, DATABASE_URL and broker/Redis variables normally.
- Keep the public media base stable. Changing it does **not** rewrite legacy URLs.

Access policy:
- Published posts and active users' avatars remain public, consistent with public
  detail/profile routes. Publishing private media in a public post makes it public.
- Nonexpired stories require an active authenticated account (the existing story
  model has no per-story ACL).
- Unpublished uploads are readable only by their owner.
- Chat attachments require active conversation membership and a live, nonhidden
  message reference. Registered thumbnails inherit the original reference's ACL.
- Media belonging to a deleted message can still be accessed through another valid
  reference or by its uploader; this is not a file-erasure policy.
- Private reads send Cache-Control: private, no-store. Do not configure a CDN or
  reverse proxy to serve /uploads directly from disk or cache private responses.

Expo **must send Authorization: Bearer <access token>** for private images/audio/
video, including range requests. Refresh expired tokens and retry. Do not put bearer
or refresh tokens into query strings. Public post/avatar URLs need no header.
HTTP range/HEAD behavior is provided by Express static middleware after ACL checks.

Existing upload contracts are retained:
- POST /api/v1/media/upload, multipart field `file` (image/video/audio).
- POST /api/v1/media/upload/images, multipart field `images` (up to 4).
- POST /api/v1/media/upload/avatar, field `avatar`.
All require auth and have a 20/minute upload route limiter in addition to global
limits. Multipart fields/parts are bounded. Image 10MiB, audio 20MiB, video 200MiB;
avatars 5MiB. Oversized mixed uploads are rejected after bounded disk storage;
Multer's outer 200MiB cap still applies while streaming.

The existing success envelope data contains `url`, `category`, `mimeType`, `size`,
`filename`, plus `fileName`, `fileMimeType`, `fileSize` aliases for messages. Images
also return dimensions and thumbnailUrl. Single uploads accept optional multipart
`duration` (seconds, client supplied, bounded to 24h); forward this to the message.
Persist upload `url` as message `mediaUrl`, not file://, content://, or the device's
picker URI. Persist thumbnailUrl/duration/type and file metadata. The message
service fills MIME/size/thumbnail from its registry when the attachment is known.

Post creation retains imageUrls[] and videoUrl; `content` may be empty when media
is provided. Optional `mediaMetadata` is an array of `{url, mimeType, size,
thumbnailUrl?, width?, height?, duration?}`. Forward upload metadata for dimensions
and duration; registry fallback supplies URL/MIME/size only. No new post media
format replaces the existing fields. Source files remain full-resolution.

Failed validation/decoding/DB registration removes originals and generated files;
failed multi-image processing removes successful files from that same batch too.
Files already referenced by messages/posts are not unlinked on deletion.
**Remaining storage limitations:** successful uploads abandoned before content
creation and process-crash remnants need a reference-aware maintenance collector;
there is no automatic TTL collector. Do not blindly delete files by age. Back up
both DB and volume. Multiple hosts need shared storage or an object-storage adapter
with equivalent ACL enforcement; per-host disks are not sufficient.

## Comments
Existing POST /api/v1/posts/:id/comments remains supported:
`{content, repliedToId?, clientRequestId?}`. Content is trimmed, 1–500 characters.
Use a fresh UUID clientRequestId per logical comment and reuse it on retries.
Without a key, two separate POSTs create two comments intentionally. With a key,
identical retries return the existing comment; conflicting reuse returns 409.
Replies must reference a live comment on the same live post.

New authenticated routes:
- GET /api/v1/posts/:id/comments?page=1&limit=20: normal success envelope containing
  a comment array and pagination metadata (including total).
- DELETE /api/v1/posts/:id/comments/:commentId: comment author or post author only;
  idempotent soft deletion, preserving reply IDs. Returns `{commentId}`.

Comment shape: id, postId, authorId, content, createdAt, repliedToId,
`author:{id,username,avatarUrl}`; list adds isMine. No password/email is exposed.
Post detail embeds the first 20 live comments; use the paginated endpoint for more.
Missing/deleted post is 404; unauthorized deletion 403; invalid input 400.

## Activity
New authenticated routes (only the caller's records):
- GET /api/v1/activity?page=1&limit=20: data `{items,total,unreadCount}` plus standard
  pagination metadata. Items include stored ID/type/content/read state/timestamp,
  actorId, resourceId (legacy navigation field), postId/commentId, and nullable
  actor/post/comment previews. Missing/deleted targets resolve to null safely.
- GET /api/v1/activity/unread-count: `{unreadCount}`.
- POST /api/v1/activity/read `{ids:[UUID,...]}` (1–200): `{count}` changed records.
- POST /api/v1/activity/read-all: `{count}`. Both are scoped by authenticated user;
  other users' IDs never modify their records.

LIKE, COMMENT/reply and FOLLOW activity are transactionally persisted with durable
notification outbox envelopes, reusing ReceiptOutbox. No self activity. Comment
replies notify post author and parent author (deduplicated if same). Dedupe keys
are unique per like pair, follow pair, or comment/recipient. Re-liking/re-following
does not create a second activity for the same pair (explicit product policy here).
Historic notifications are retained without invented keys/actors.

Kafka NOTIFICATIONS and socket `notification:new` are unchanged; payloads add stable
`id`, createdAt and optional commentId. Kafka consumers emit, not reinsert rows.
Transport remains at-least-once: frontend deduplicates by activity ID and refetches
activity on reconnect. Actor previews come from the REST feed; existing event
fields remain compatible. Legacy SHARE producers are not converted to transactional
activity creation in this patch.

## Schema / migration
`20261031000000_media_comments_activity` adds:
- MediaAsset with cascading owner FK, unique key/URL and owner/time index.
- Post.mediaMetadata JSONB; URL/reference lookup indexes on messages, posts (GIN
  for image arrays), stories, avatars and thumbnail source URLs.
- Comment.clientRequestId + unique(authorId,clientRequestId), post/time/ID index,
  and self-reply FK.
- Notification dedupeKey, commentId, postId, actor/comment/post relations and
  user/time/ID pagination index. Existing user/unread index is retained.
Legacy comment-parent and notification-actor FKs are NOT VALID so dangling legacy
navigation references are retained; new writes are checked. Inspect/reconcile
legacy orphans, then VALIDATE CONSTRAINT in a planned maintenance window. No
legacy rows were deleted or rewritten. MessageReceipt remains unchanged.

## Deployment (actual Compose service names)
First take a PostgreSQL backup and snapshot/back up uploads_data. Configure HTTPS
and the variables above, then from the repository:
```sh
docker compose up -d postgres redis zookeeper kafka
docker compose --profile tools build migrate
docker compose --profile tools run --rm migrate
docker compose build app
docker compose up -d app
docker compose logs --tail=100 app
```
The new tools-profile `migrate` service uses the builder stage because Prisma CLI
is a devDependency and is absent from the production runner. It runs `prisma
migrate deploy`, not migrate dev/reset. Apply both the messaging migration and the
new media/activity migration before deploying application changes. All migration
commands here are **documented, not executed against Docker or production**.
Compose now uses POSTGRES_PASSWORD consistently in app and migration connection
URLs; database URLs require URL-encoding special password characters. Existing DB
passwords are not changed merely by changing Compose environment values.

Serve HTTPS at the configured media host, proxy /uploads to the **application**,
forward Authorization and Range, and allow upload bodies >=200MiB plus multipart
headers with adequate timeouts. Set reverse-proxy trust explicitly to your known
proxy topology before enabling IP-based production rate limits; do not blindly
trust forwarded client addresses. No reverse-proxy config existed in the repo.
Infra ports for Postgres/Redis/Kafka UI are now bound to host loopback; use a firewall
for remaining Kafka/application exposure. Do not expose broker plaintext to users.
Never run `docker compose down -v` on retained data.

Legacy localhost/device URLs already in DB are not repaired automatically. Audit
message media_url/thumbnail_url, posts image_urls/video_url/media_metadata, story
media_url, user avatar_url and shared-reference snapshots. Replace only known
server-upload prefixes after confirming actual files exist in the volume. Device
URIs with no uploaded server file require re-upload; a URL rewrite cannot recover
them. Unknown historical upload owners are not invented in MediaAsset; valid live
DB references still authorize their media.

## Required deployment/device gates
1. Upload real JPEG/PNG, MP4 H.264/AAC and M4A AAC from account A; persist them in a
   post, DM and group, using the returned URLs and actual metadata.
2. From account B on a different physical device/network, read history and receive
   message:new; verify full image, thumbnail, video seek and voice playback with
   auth headers. Confirm account C outside the conversation receives 403.
3. Confirm public posts/profile/bookmarks render identical media. Delete a comment
   and check counts/activity navigation; disconnect/reconnect and refetch activity.
4. Record an upload URL, run `docker compose restart app`, and fetch it again.
   Recreate app without removing volumes and repeat. Confirm DB rows and bytes survive.
5. Test broker/Redis restarts, offline recipient recovery, media token refresh and
   reverse-proxy range/body limits. Verify DB/volume restore procedures.

## Verification performed
- npm run build: passed.
- npm run db:validate:wasm: passed (22 models).
- npm test: 31 passed. Actual Prisma queries execute against PGlite after applying
  SQL migrations. HTTP uploads/ACL/ranges/comment routes run through real Express;
  Kafka is a boundary double. Existing real Socket.IO receipt tests retained.
- Includes image/video/audio private and group send/history, private/public/stranger
  access, JPEG thumbnails, bad signatures, oversized images, DB-failure file cleanup,
  comments retry/pagination/counts/authorization, activities/dedupe/scoped reads/
  publication retry, and legacy-record migration preservation.
- Video/audio test fixtures validate container-header/storage/range handling, **not
  decoding or real playback**. Images are actually decoded by sharp.
- npm run lint: passed with 8 warnings (0 errors).
- Docker CLI/daemon and physical phones unavailable; restart durability, real media
  codecs, network reachability and container build were not tested.
- Dependency install reported 25 vulnerabilities (13 moderate, 11 high, 1 critical).
  Resolve and retest separately before broad production rollout.

## Remaining limitations / blockers to a production-ready claim
No transcoding, ffprobe codec inspection, or automatic video thumbnails/duration
extraction. Header checks reject obvious MIME spoofing but do not establish video/
audio decodability or malware safety. Prefer MP4 H.264/AAC and M4A AAC; WebM/MOV
support varies by device. Thumbnail/duration provided by clients is preserved but
not independently verified. Object storage/multi-host ACL delivery, unattended
orphan GC, legacy URL repair, device tests and Docker persistence tests remain.
Existing share-to-conversation methods and legacy SHARE activities still need a
separate completion/idempotency audit; they are not claimed verified here. Receipt
outbox is preserved; edit/conversation-deletion still use their legacy direct Kafka
publication paths. Do not treat this patch as a complete security certification.

## Changed files
Infrastructure: .env.example, .dockerignore, docker-compose.yml, package.json,
package-lock.json. Schema: prisma/schema.prisma and both messaging/media migrations.
Media: src/config/media.ts, src/app.ts, src/middlewares/{upload,media-access}.ts,
src/services/media.service.ts, src/controllers/media.controller.ts, src/routes/media.routes.ts.
Posts/comments/profile: src/services/{post,user}.service.ts,
src/controllers/post.controller.ts, src/routes/post.routes.ts.
Activity: src/services/activity.service.ts, src/routes/{activity,index}.routes.ts.
Shared contracts/security: src/middlewares/{schemas,validate,errorHandler}.ts,
src/utils/jwt.ts, src/socket/index.ts. Messaging: src/services/{message.service,
message.dto,receipt-outbox.service}.ts, src/controllers/message.controller.ts,
src/routes/message.routes.ts, src/socket/chat.handler.ts, src/kafka/{producer,consumer}.ts.
Verification/documentation: test/receipts.test.mjs, docs/messaging-reliability.md,
docs/production-readiness.md.
