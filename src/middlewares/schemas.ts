import { z } from 'zod';

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
    avatarUrl: z.string().url().optional(),
  }),
});

// ─── Posts ─────────────────────────────────────────────────
export const createPostSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(2000),
    imageUrls: z.array(z.string().url()).max(4).optional(),
    videoUrl: z.string().url().optional(),
  }),
});

export const updatePostSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(2000).optional(),
    imageUrls: z.array(z.string().url()).max(4).optional(),
    videoUrl: z.string().url().optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const commentSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(500),
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
    mediaUrl: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).optional(),
    duration: z.number().optional(),
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
    mediaUrl: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).optional(),
    duration: z.number().optional(),
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
    mediaUrl: z.string().url(),
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
