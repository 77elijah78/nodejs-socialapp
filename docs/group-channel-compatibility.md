# Group and channel frontend compatibility

The backend provides authenticated compatibility routes for the current frontend:

- Group management: `/api/v1/messages/groups/...`
- Channel discovery, subscription, and posts: `/api/v1/channels/...`
- Existing `/api/v1/communities/...` routes remain available.

Group and channel mutations continue to use the existing community services, Prisma records, membership authorization, message outbox, abuse limits, and API response envelope. Group/channel avatars are stored in `Conversation.groupAvatar`. Channel post pin state is stored on `Message.pinned` by the additive `20261105000000_channel_post_pinning` migration.

## Retry and invite limitations

The compatibility routes accept `Idempotency-Key` when supplied, but do not require it because the current frontend does not send one. Without a key, adding an already-active group member and joining an already-joined public channel are state-idempotent. A retry of group/channel creation or channel-post creation after a lost response can create a duplicate; there is no safe natural key to deduplicate those requests without a client request identifier. The existing `/communities` creation routes retain their required-key behavior.

Private channel subscription remains protected by the invite token. The backend accepts `{ "inviteToken": "..." }` at `POST /api/v1/channels/:id/subscribe`, and private-channel creation returns the invite token to its owner. The current frontend `ChannelService.subscribe()` sends `{}` and its create normalizer does not retain the token, so private-channel joining is not usable through that frontend until its contract/UI adds an invite-token flow. Public subscribe/unsubscribe works without that flow.

The pin migration is additive and is not applied automatically here. Deployments must apply it through the normal reviewed migration process before running the updated backend; no live database migration or deployment was performed for this change.
