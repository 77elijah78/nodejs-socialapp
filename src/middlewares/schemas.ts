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

// ─── Users ─────────────────────────────────────────────────
export const updateProfileSchema = z.object({
  body: z.object({
    displayName: z.string().max(60).optional(),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, underscores').optional(),
    bio: z.string().max(300).optional(),
    avatarUrl: mediaUrl.optional(),
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
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'SHARED_POST', 'SHARED_STORY']).optional(),
    duration: z.number().nonnegative().optional(),
    fileName: z.string().max(255).optional(),
    fileMimeType: z.string().max(255).optional(),
    fileSize: z.number().int().nonnegative().max(2147483647).optional(),
    sharedReference: z.record(z.unknown()).optional(),
    repliedToId: z.string().uuid().optional(),
    receiverId: z.string().uuid().optional(),
  }).refine(
    (data) => data.content || data.mediaUrl,
    { message: 'Either content or mediaUrl must be provided' }
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
    content: z.string().max(5000).optional(),
    mediaUrl: mediaUrl.optional(),
    thumbnailUrl: mediaUrl.optional(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'SHARED_POST', 'SHARED_STORY']).optional(),
    duration: z.number().nonnegative().optional(),
    fileName: z.string().max(255).optional(),
    fileMimeType: z.string().max(255).optional(),
    fileSize: z.number().int().nonnegative().max(2147483647).optional(),
    sharedReference: z.record(z.unknown()).optional(),
    repliedToId: z.string().uuid(),
    receiverId: z.string().uuid().optional(),
  }).refine(
    (data) => data.content || data.mediaUrl,
    { message: 'Either content or mediaUrl must be provided' }
  ),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const markDeliveredSchema = z.object({
  body: z.object({
    messageIds: z.array(z.string().uuid()).min(1),
  }),
});

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
