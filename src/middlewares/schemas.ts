import { z } from 'zod';
import { isSharedMediaUrl } from '../config/media.js';
const mediaUrl = z.string().url().refine(isSharedMediaUrl, 'Expected a shared HTTP(S) media URL, not a device URI or localhost');

// ─── Auth ──────────────────────────────────────────────────
export const registerSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, underscores'),
    email: z.string().email(),
    password: z.string().min(8).regex(/[A-Z]/, 'Needs uppercase').regex(/[0-9]/, 'Needs number'),
    displayName: z.string().max(60).optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
});

export const refreshSchema = z.object({
  body: z.object({ refreshToken: z.string().min(1) }),
});

export const googleTokenSchema = z.object({
  body: z.object({ idToken: z.string().min(10).max(8192) }).strict(),
});

// ─── Users ─────────────────────────────────────────────────
export const updateProfileSchema = z.object({
  body: z.object({
    displayName: z.string().max(60).optional(),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, underscores').optional(),
    bio: z.string().max(300).optional(),
    avatarUrl: mediaUrl.optional(),
    isPrivate: z.boolean().optional(),
  }),
});

// ─── Posts ─────────────────────────────────────────────────
export const createPostSchema = z.object({
  body: z.object({
    content: z.string().max(2000).default(''),
    imageUrls: z.array(mediaUrl).max(4).optional(),
    videoUrl: mediaUrl.optional(),
    mediaMetadata: z.array(z.object({
      url: mediaUrl, thumbnailUrl: mediaUrl.optional(), mimeType: z.string().max(100),
      size: z.number().int().nonnegative(), width: z.number().positive().optional(),
      height: z.number().positive().optional(), duration: z.number().nonnegative().optional(),
    })).max(5).optional(),
  }),
});

export const updatePostSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(2000).optional(),
    imageUrls: z.array(mediaUrl).max(4).optional(),
    videoUrl: mediaUrl.optional(),
    mediaMetadata: z.array(z.object({
      url: mediaUrl, thumbnailUrl: mediaUrl.optional(), mimeType: z.string().max(100),
      size: z.number().int().nonnegative(), width: z.number().positive().optional(),
      height: z.number().positive().optional(), duration: z.number().nonnegative().optional(),
    })).max(5).optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const commentSchema = z.object({
  body: z.object({
    content: z.string().trim().min(1).max(500),
    clientRequestId: z.string().uuid().optional(),
    repliedToId: z.string().uuid().optional(),
  }),
});

// ─── Messages ──────────────────────────────────────────────
export const startConversationSchema = z.object({
  body: z.object({ userId: z.string().uuid() }),
});

export const deleteConversationSchema = z.object({
  params: z.object({ conversationId: z.string().uuid() }),
});

export const sendMessageSchema = z.object({
  body: z.object({
    content: z.string().max(5000).optional(),
    mediaUrl: mediaUrl.optional(),
    thumbnailUrl: mediaUrl.optional(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'SHARED_POST', 'SHARED_STORY', 'STICKER']).optional(),
    stickerId: z.string().uuid().optional(),
    duration: z.number().nonnegative().optional(),
    fileName: z.string().max(255).optional(),
    fileMimeType: z.string().max(255).optional(),
    fileSize: z.number().int().nonnegative().max(2147483647).optional(),
    sharedReference: z.record(z.string(), z.unknown()).optional(),
    repliedToId: z.string().uuid().optional(),
    receiverId: z.string().uuid().optional(),
  }).refine(
    (data) => data.type === 'STICKER' ? !!data.stickerId && !data.content && !data.mediaUrl && !data.thumbnailUrl : !!(data.content || data.mediaUrl) && !data.stickerId,
    { message: 'Provide content or media, or a stickerId for sticker messages' }
  ),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const editMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(5000),
  }),
  params: z.object({
    messageId: z.string().uuid(),
  }),
});

export const deleteMessageSchema = z.object({
  body: z.object({
    deleteFor: z.enum(['me', 'everyone']).optional().default('me'),
  }),
  params: z.object({
    messageId: z.string().uuid(),
  }),
});

export const forwardMessageSchema = z.object({
  body: z.object({
    messageId: z.string().uuid(),
    targetConversationId: z.string().uuid(),
  }),
});

export const replyMessageSchema = z.object({
  body: z.object({
    notificationAction: z.object({
      contractVersion: z.literal(2), actionId: z.string().uuid(),
      recipientUserId: z.string().uuid(), deviceId: z.string().uuid(), notificationId: z.string().uuid(),
    }).strict().optional(),
    content: z.string().max(5000).optional(),
    mediaUrl: mediaUrl.optional(),
    thumbnailUrl: mediaUrl.optional(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'SHARED_POST', 'SHARED_STORY']).optional(),
    duration: z.number().nonnegative().optional(),
    fileName: z.string().max(255).optional(),
    fileMimeType: z.string().max(255).optional(),
    fileSize: z.number().int().nonnegative().max(2147483647).optional(),
    sharedReference: z.record(z.string(), z.unknown()).optional(),
    repliedToId: z.string().uuid(),
    receiverId: z.string().uuid().optional(),
  }).refine(
    (data) => data.content || data.mediaUrl,
    { message: 'Either content or mediaUrl must be provided' }
  ).refine(data => !data.notificationAction || (
    !!data.content?.trim() && (!data.type || data.type === 'TEXT') && !data.mediaUrl && !data.thumbnailUrl &&
    data.duration === undefined && !data.fileName && !data.fileMimeType && data.fileSize === undefined && !data.sharedReference
  ), { message: 'Notification replies must contain text only' }),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const markDeliveredSchema = z.object({
  body: z.object({
    messageIds: z.array(z.string().uuid()).min(1),
  }),
});

// ─── Groups, channels, and sticker packs ────────────────────
const communityId = z.string().uuid();
const memberIds = z.array(communityId).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Member IDs must be unique');
const channelSlug = z.string().min(3).max(40).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use a lowercase URL-safe slug');

export const createGroupSchema = z.object({ body: z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(1000).optional(), memberIds,
}) });
export const communityIdSchema = z.object({ params: z.object({ conversationId: communityId }) });
export const updateGroupSchema = z.object({
  params: z.object({ conversationId: communityId }),
  body: z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(1000).nullable().optional() })
    .refine(data => data.name !== undefined || data.description !== undefined, 'Provide a group name or description'),
});
export const groupMembersSchema = z.object({ params: z.object({ conversationId: communityId }), body: z.object({ memberIds }) });
export const groupMemberSchema = z.object({ params: z.object({ conversationId: communityId, memberId: communityId }) });
export const memberRoleSchema = z.object({
  params: z.object({ conversationId: communityId, memberId: communityId }),
  body: z.object({ role: z.enum(['MEMBER', 'ADMIN']) }),
});
export const createChannelSchema = z.object({
  body: z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(1000).optional(),
    isPublic: z.boolean().default(false), slug: channelSlug.optional() })
    .refine(data => !data.isPublic || !!data.slug, 'Public channels require a slug'),
});
export const updateChannelSchema = z.object({
  params: z.object({ conversationId: communityId }),
  body: z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(1000).nullable().optional(),
    isPublic: z.boolean().optional(), slug: channelSlug.nullable().optional() })
    .refine(data => Object.values(data).some(value => value !== undefined), 'Provide a channel setting to update'),
});
export const joinChannelSchema = z.object({
  params: z.object({ conversationId: communityId }),
  body: z.object({ inviteToken: z.string().min(32).max(128).optional() }).strict(),
});
export const channelMemberSchema = groupMemberSchema;
export const stickerPackSchema = z.object({ body: z.object({
  shortName: z.string().min(3).max(40).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, 'Use a lowercase pack name'),
  title: z.string().trim().min(1).max(80), description: z.string().trim().max(1000).optional(),
  isPublic: z.boolean().default(false),
  stickers: z.array(z.object({ mediaUrl, emoji: z.string().max(32).optional() }).strict()).min(1).max(120),
}) });
export const stickerIdSchema = z.object({ params: z.object({ stickerId: communityId }) });
export const packIdSchema = z.object({ params: z.object({ packId: communityId }) });
export const paginationQuerySchema = z.object({ query: z.object({
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
}) });

// ─── Stories ────────────────────────────────────────────────
export const createStorySchema = z.object({
  body: z.object({
    mediaUrl: mediaUrl,
    mediaType: z.enum(['image', 'video']),
    caption: z.string().max(200).optional(),
  }),
});

export const shareSchema = z.object({
  body: z.object({
    conversationId: z.string().uuid(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const shareStorySchema = z.object({
  body: z.object({
    conversationId: z.string().uuid(),
  }),
  params: z.object({ storyId: z.string().uuid() }),
});

export const reportPostSchema = z.object({
  body: z.object({
    reason: z.string().min(1).max(200),
    details: z.string().max(1000).optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const shareToUserSchema = z.object({
  body: z.object({
    username: z.string().min(1).max(30),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const syncReceiptsSchema = z.object({ body: z.object({
  messageIds: z.array(z.string().uuid()).max(200),
}) });

export const batchDeletePayload = z.object({
  conversationId: z.string().uuid(), messageIds: z.array(z.string().uuid()).min(1).max(200),
  deleteFor: z.enum(['me', 'everyone']),
});
export const batchDeleteSchema = z.object({ body: batchDeletePayload });

// Notification and legacy activity routes share the same records and validation.
export const notificationPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export const notificationIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });
export const notificationReadSchema = z.object({ body: z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
}) });
