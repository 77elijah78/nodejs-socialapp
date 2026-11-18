# Google sign-in, communities, stickers, and abuse protection

This change extends the existing Express/Prisma/Redis/Kafka/Socket.IO application. It does not replace the existing email/password JWT or message flows.

## Google authentication

- `POST /api/v1/auth/google` accepts `{ "idToken": "..." }` and requires an `Idempotency-Key`. The server verifies the token with Google's rotating signing keys through `google-auth-library`, checks the configured audience (`GOOGLE_CLIENT_ID`), issuer, expiry, and `email_verified`, then issues the existing access/refresh JWT pair.
- A Google subject is stored in `google_identities` with unique provider/subject and provider/user constraints. A verified Google email is **not** silently linked to an existing password account; the user must authenticate first and call `POST /api/v1/auth/google/link` with the verified ID token.
- Linking requires an authenticated JWT and an `Idempotency-Key`. Google sign-up respects the existing registration-enabled setting. Account-status checks remain in force.
- Configure `GOOGLE_CLIENT_ID` in the application environment. Without it, Google endpoints return `503` rather than accepting unverifiable tokens.

## Groups and channels

All endpoints below require an existing Bearer JWT. Community mutations that create a resource, add members, join a channel, or rotate an invite require an `Idempotency-Key` (16–128 non-space printable ASCII characters; a UUID is suitable).

### Groups — `/api/v1/communities/groups`

- `GET /?limit=30&cursor=...` — groups the caller currently belongs to; keyset-paginated.
- `POST /` — `{ name, description?, memberIds }`; creator becomes owner/admin. Create accepts up to 100 invitees.
- `GET /:conversationId` — member-only detail and active member list.
- `PATCH /:conversationId` — active admins may update name/description.
- `POST /:conversationId/members` — admins add active users with `{ memberIds }`.
- `DELETE /:conversationId/members/:memberId` — admins remove members; a member may leave. The owner cannot leave, and the group must retain an admin.
- `PATCH /:conversationId/members/:memberId/role` — owner-only `{ role: "MEMBER" | "ADMIN" }`.

### Channels — `/api/v1/communities/channels`

- `GET /?limit=30&cursor=...` — public channels, keyset-paginated.
- `POST /` — `{ name, description?, isPublic, slug? }`; public channels require a unique slug. Private channels return a one-time invite token; only its SHA-256 hash is stored.
- `GET /:conversationId` — public details or private details for active members; subscriber identities are not returned to non-members.
- `PATCH /:conversationId` — owner-only channel settings. Changing visibility revokes the previous private invite.
- `POST /:conversationId/join` — public join or `{ inviteToken }` for a private channel.
- `DELETE /:conversationId/leave` and `DELETE /:conversationId/members/:memberId` — leave or admin removal; the owner cannot leave.
- `PATCH /:conversationId/members/:memberId/role` — owner-only administrator changes.
- `POST /:conversationId/invite/rotate` — owner-only; returns a replacement private invite once.

Channel posts use the existing message history/send routes under `/api/v1/messages/conversations/:conversationId/messages`. Channel members can read; only active channel administrators can post. Groups are capped at 500 active members and channels at 5,000 active subscribers because the current message/receipt/outbox pipeline performs bounded per-recipient fanout. Larger broadcast channels need a separate scalable fanout/read-state design.

## Sticker packs

Sticker assets must be images uploaded through this app and owned by the pack creator; Telegram proprietary sticker assets are not included. Each asset is limited to 512 KB, each pack to 120 stickers and 10 MB total.

- `GET /api/v1/stickers/packs?limit=30&cursor=...` and `GET /packs/:packId` — public, owned, or installed packs.
- `POST /packs` — create a pack from owned upload URLs; requires `Idempotency-Key`.
- `PUT /packs/:packId/install` / `DELETE /packs/:packId/install` — install or remove a pack.
- `PUT /:stickerId/favorite` / `DELETE /:stickerId/favorite` — favorite controls.
- `GET /favorites?limit=30&cursor=...` / `GET /recents?limit=30&cursor=...` — caller-only keyset-paginated lists.
- Send a sticker using the existing message route with `{ "type": "STICKER", "stickerId": "..." }`. The server resolves the sticker/media URL, checks pack visibility or installation, persists the message and recent-use row transactionally, and queues delivery events in the existing outbox.

## Redis abuse limits and replay protection

`src/middlewares/abuse-protection.ts` applies a single atomic Redis Lua operation over the per-IP and (when authenticated) per-user counters for each route category. Exceeding a configurable limit starts a Redis cooldown and returns HTTP `429` with `Retry-After`. Identifier keys and suspicious-activity logs use HMAC hashes; raw user IDs/IPs are not logged. The security gate fails closed with `503` plus `Retry-After: 1` if Redis is unavailable or rejects writes. The supplied Compose Redis config uses `noeviction`: do not use an eviction policy for the security keys, because silently evicted counters or replay claims can weaken protection; give Redis enough memory and monitor write errors.

Categories are `AUTH`, `MESSAGES`, `MEDIA`, `STICKERS`, `SOCIAL`, `EXPLORE`, and `PUSH`. Each accepts `ABUSE_<CATEGORY>_WINDOW_MS`, `_IP_MAX`, `_USER_MAX`, and `_COOLDOWN_MS`; `.env.example` and the Compose files contain the defaults. Set `ABUSE_HASH_SECRET` to a dedicated random secret in production (the JWT secret is the fallback). Set `TRUST_PROXY_HOPS` only to the number of known reverse proxies in front of Express; leave it `0` when clients connect directly.

`Idempotency-Key` claims are atomic in Redis, scoped to a hashed authenticated user and the request fingerprint, and retained for 24 hours by default. A duplicate or mismatched replay receives `409`. Failed non-2xx operations release their claim; successful requests retain a replay tombstone. Existing message sends accept the header optionally for compatibility, while new non-idempotent community/account-creation actions require it.

## Persistence and Kafka

The additive migration `prisma/migrations/20261104000000_google_channels_stickers_abuse/migration.sql` adds identity, community-role/channel, and sticker models/columns/indexes. Existing group rows are classified and their earliest active participant is backfilled as owner/admin; existing direct messages and message history remain intact.

Community membership/channel changes, sticker pack/install/favorite mutations, message edits, and direct-conversation deletions enqueue durable intents in the existing `receipt_outbox`. Kafka topics `chat.membership` and `chat.stickers` are added; events publish asynchronously and are retried by the existing at-least-once outbox worker. PostgreSQL mutation commits do not depend on Kafka availability.

## Operational note

The migration has only been exercised against isolated PGlite test databases in this work session. It has **not** been applied to a live or Compose database, and no deployment or merge has been performed. Back up the target database and review the migration before running `prisma migrate deploy` in an authorized environment.
