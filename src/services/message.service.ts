import { createHash } from 'node:crypto';
import { isSharedMediaUrl } from '../config/media.js';
import { normalizeSharedMediaReferences, normalizeStoredMediaReferences } from './media-url.service.js';
import { enqueueMessagePush } from './push-device.service.js';
import { z } from 'zod';
import { messageInclude, serializeMessage } from './message.dto.js';
import { prisma } from '../config/database.js';
import { AppError, ConflictError, NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { publishReceipts } from './receipt-outbox.service.js';
import { stickerService } from './sticker.service.js';
import { communityService } from './community.service.js';
import { enqueueDomainEvent } from './domain-outbox.service.js';
import { Prisma, type MessageType } from '@prisma/client';
import { boundedLimit, decodeCursor, encodeCursor } from '../utils/opaque-cursor.js';


function eligible(userId: string) {
  return { deletions: { none: { userId } }, senderId: { not: userId }, deletedAt: null,
    conversation: { participants: { some: { userId, deletedAt: null } } },
    OR: [{ receiverId: userId }, { conversation: { isGroup: true } }],
  };
}
async function requireMember(conversationId: string, userId: string) {
  const member = await prisma.conversationParticipant.findUnique({ where: {
    conversationId_userId: { conversationId, userId },
  } });
  if (!member || member.deletedAt) throw new ForbiddenError('Not an active participant');
}
async function recipientsFor(conversationId: string, senderId: string, receiverId?: string, db: Prisma.TransactionClient = prisma) {
  const conversation = await db.conversation.findUniqueOrThrow({ where: { id: conversationId },
    include: { participants: { where: { deletedAt: null } } } });
  const recipients = conversation.participants.filter(p => p.userId !== senderId).map(p => p.userId);
  if ((!recipients.length && conversation.kind !== 'CHANNEL') || (receiverId && !recipients.includes(receiverId)) ||
    (!conversation.isGroup && recipients.length !== 1)) throw new ValidationError('Invalid recipients');
  return { recipients, isGroup: conversation.isGroup, kind: conversation.kind, ownerId: conversation.ownerId };
}
/** Canonicalizes stored attachment links on the way out; redacts unsafe legacy values. */
async function normalizeMessageMedia<T extends { mediaUrl?: string | null; thumbnailUrl?: string | null }>(messages: T[]): Promise<T[]> {
  const urls = messages.flatMap(message => [message.mediaUrl, message.thumbnailUrl].filter((url): url is string => !!url));
  if (!urls.length) return messages;
  const normalized = await normalizeStoredMediaReferences(urls);
  const byUrl = new Map(urls.map((url, index) => [url, normalized.values[index] ?? null]));
  return messages.map(message => ({
    ...message,
    ...(message.mediaUrl !== undefined ? { mediaUrl: message.mediaUrl ? byUrl.get(message.mediaUrl) ?? null : message.mediaUrl } : {}),
    ...(message.thumbnailUrl !== undefined ? { thumbnailUrl: message.thumbnailUrl ? byUrl.get(message.thumbnailUrl) ?? null : message.thumbnailUrl } : {}),
  })) as T[];
}

async function receiptDTOs<T extends { id: string; conversationId: string; deletedAt?: Date | null; mediaUrl?: string | null; thumbnailUrl?: string | null }>(messages: T[], userId: string) {
  const [receipts, conversations] = await Promise.all([
    prisma.messageReceipt.findMany({ where: { userId, messageId: { in: messages.map(m => m.id) } } }),
    prisma.conversation.findMany({ where: { id: { in: messages.map(m => m.conversationId) } }, select: { id: true, isGroup: true } }),
  ]);
  const serialized = await normalizeMessageMedia(messages.map(m => serializeMessage(m)));
  return serialized.map(m => ({ ...m, isGroup: conversations.find(c => c.id === m.conversationId)?.isGroup ?? false,
    readByMe: !!receipts.find(r => r.messageId === m.id)?.readAt }));
}

export type NotificationReplyAction = {
  contractVersion: 2; actionId: string; recipientUserId: string; deviceId: string; notificationId: string;
};

const directConversationSelect = {
  id: true, isGroup: true, kind: true, groupName: true, groupAvatar: true, description: true,
  ownerId: true, isPublic: true, slug: true, createdAt: true, updatedAt: true,
  participants: { select: {
    conversationId: true, userId: true, joinedAt: true, role: true, lastReadAt: true, deletedAt: true,
    user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  } },
} satisfies Prisma.ConversationSelect;

async function normalizeConversationParticipants<T extends { participants: Array<{ user: { avatarUrl: string | null } }> }>(conversation: T): Promise<T> {
  const avatars = await normalizeStoredMediaReferences(conversation.participants.map(participant => participant.user.avatarUrl));
  return {
    ...conversation,
    participants: conversation.participants.map((participant, index) => ({
      ...participant, user: { ...participant.user, avatarUrl: avatars.values[index] ?? null },
    })),
  } as T;
}

export const messageService = {
  async getOrCreateConversation(userAId: string, userBId: string) {
    if (userAId === userBId) {
      throw new ValidationError('Cannot create a conversation with yourself');
    }

    // Find existing active DM where BOTH users are participants AND neither has deleted it.
    // Use an explicit projection so the invitation token hash is never serialized.
    const existing = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
        participants: { none: { deletedAt: { not: null } } },
      },
      select: directConversationSelect,
    });
    if (existing) return normalizeConversationParticipants(existing);

    // If a conversation between these two users exists but one party deleted it,
    // hard-delete the stale one and create a fresh conversation.
    const stale = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
      },
    });
    if (stale) await prisma.conversation.delete({ where: { id: stale.id } });

    const created = await prisma.conversation.create({
      data: {
        isGroup: false,
        participants: { create: [{ userId: userAId }, { userId: userBId }] },
      },
      select: directConversationSelect,
    });
    return normalizeConversationParticipants(created);
  },

  async getUserConversations(userId: string) {
    // Use an explicit scalar selection: Conversation contains inviteTokenHash, which
    // must never be serialized as part of a conversation-list response.
    const conversations = await prisma.conversation.findMany({
      where: { participants: { some: { userId, deletedAt: null } } },
      select: {
        id: true, isGroup: true, kind: true, groupName: true, groupAvatar: true, createdAt: true, updatedAt: true,
        messages: { where: { deletions: { none: { userId } } }, include: messageInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!conversations.length) return [];

    const groupAndDirectIds = conversations.filter(conversation => conversation.kind !== 'CHANNEL').map(conversation => conversation.id);
    const channelIds = conversations.filter(conversation => conversation.kind === 'CHANNEL').map(conversation => conversation.id);
    const participantFilters = [
      ...(groupAndDirectIds.length ? [{ conversationId: { in: groupAndDirectIds } }] : []),
      ...(channelIds.length ? [{ conversationId: { in: channelIds }, userId }] : []),
    ];
    const participants = await prisma.conversationParticipant.findMany({
      where: { deletedAt: null, OR: participantFilters },
      select: { conversationId: true, user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    const participantAvatars = await normalizeStoredMediaReferences(participants.map(participant => participant.user.avatarUrl));
    const byConversation = new Map<string, Array<{ user: typeof participants[number]['user'] }>>();
    participants.forEach((participant, index) => {
      const current = byConversation.get(participant.conversationId) ?? [];
      current.push({ user: { ...participant.user, avatarUrl: participantAvatars.values[index] ?? null } });
      byConversation.set(participant.conversationId, current);
    });

    const groupAvatars = await normalizeStoredMediaReferences(conversations.map(conversation => conversation.groupAvatar));
    return Promise.all(conversations.map(async (conversation, index) => ({
      id: conversation.id, isGroup: conversation.isGroup, kind: conversation.kind,
      groupName: conversation.groupName, groupAvatar: groupAvatars.values[index] ?? null,
      createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
      // Channel rosters are private; the conversation response only needs the viewer.
      participants: byConversation.get(conversation.id) ?? [],
      messages: await normalizeMessageMedia(conversation.messages.map(serializeMessage)),
      unreadCount: await prisma.messageReceipt.count({ where: { userId, readAt: null,
        message: { conversationId: conversation.id, deletedAt: null, deletions: { none: { userId } } } } }),
    })));
  },

  async getMessages(
    conversationId: string,
    userId: string,
    page: number,
    limit: number,
    cursorId?: string,
    before?: number,
  ) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant in this conversation');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    let cursorFilter: Prisma.MessageWhereInput = {};
    if (cursorId) {
      const cursorMessage = await prisma.message.findUnique({
        where: { id: cursorId },
        select: { createdAt: true, conversationId: true },
      });
      if (!cursorMessage || cursorMessage.conversationId !== conversationId) throw new ValidationError('Invalid conversation cursor');
      cursorFilter = { OR: [ { createdAt: { lt: cursorMessage.createdAt } }, { createdAt: cursorMessage.createdAt, id: { lt: cursorId } } ] };
    } else if (before !== undefined) {
      if (!Number.isFinite(before) || !Number.isFinite(new Date(before).getTime())) throw new ValidationError('Invalid history timestamp');
      cursorFilter = { createdAt: { lt: new Date(before) } };
    }

    const where: Prisma.MessageWhereInput = { conversationId, deletions: { none: { userId } }, ...cursorFilter };

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        include: messageInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page > 1 && !cursorId && !before ? (page - 1) * limit : 0,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    const nextCursor = messages.length === limit ? messages[messages.length - 1]?.id : undefined;

    return { messages: await receiptDTOs(messages.reverse(), userId), total, nextCursor };
  },

  async sendMessage(
    conversationId: string,
    senderId: string,
    content: string,
    receiverId?: string,
    options?: {
      type?: MessageType;
      mediaUrl?: string | null;
      thumbnailUrl?: string | null;
      duration?: number | null;
      repliedToId?: string | null;
      forwardedFromId?: string | null;
      fileName?: string | null;
      fileMimeType?: string | null;
      fileSize?: number | null;
      sharedReference?: Prisma.InputJsonValue;
      stickerId?: string | null;
      pinned?: boolean;
      notificationAction?: NotificationReplyAction;
    },
    afterPersist?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    for (const url of [options?.mediaUrl, options?.thumbnailUrl]) if (url && !isSharedMediaUrl(url)) throw new ValidationError('Invalid shared media URL');
    if (options && (options.mediaUrl || options.thumbnailUrl)) {
      const values = [options.mediaUrl ?? null, options.thumbnailUrl ?? null];
      const normalized = await normalizeSharedMediaReferences(values.filter((value): value is string => !!value), { ownerId: senderId });
      let index = 0;
      const mediaUrl = options.mediaUrl ? normalized.values[index++]! : options.mediaUrl;
      const thumbnailUrl = options.thumbnailUrl ? normalized.values[index++]! : options.thumbnailUrl;
      options = { ...options, mediaUrl, thumbnailUrl };
    }
    if (options?.type === 'STICKER') {
      if (!options.stickerId || content?.trim() || options.mediaUrl || options.thumbnailUrl || options.duration != null ||
          options.fileName || options.fileMimeType || options.fileSize != null || options.sharedReference || options.forwardedFromId) {
        throw new ValidationError('Sticker messages must contain only a sticker ID and optional reply target');
      }
    } else if (options?.stickerId) throw new ValidationError('Sticker ID is only valid for sticker messages');
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant in this conversation');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    if (options?.mediaUrl) {
      const asset = await prisma.mediaAsset.findUnique({ where: { url: options.mediaUrl } });
      if (asset) {
        const thumbnail = await prisma.mediaAsset.findFirst({ where: { sourceUrl: asset.url }, select: { url: true } });
        options = { ...options, fileMimeType: asset.mimeType, fileSize: asset.size,
          fileName: options.fileName ?? asset.key.split('/').pop(), thumbnailUrl: options.thumbnailUrl ?? thumbnail?.url };
      }
    }
    // Message, idempotency tombstone, receipts and publication intents commit together.
    const result = await prisma.$transaction(async tx => {
    const action = options?.notificationAction;
    if (action) {
      z.object({ contractVersion: z.literal(2), actionId: z.string().uuid(), recipientUserId: z.string().uuid(),
        deviceId: z.string().uuid(), notificationId: z.string().uuid() }).strict().parse(action);
      if (action.recipientUserId !== senderId) throw new ForbiddenError('Notification account mismatch');
      if (!content?.trim() || content.length > 5000 || (options?.type && options.type !== 'TEXT') ||
        options?.mediaUrl || options?.thumbnailUrl || options?.duration != null || options?.fileName ||
        options?.fileMimeType || options?.fileSize != null || options?.sharedReference || options?.forwardedFromId || !options?.repliedToId)
        throw new ValidationError('Notification replies must contain text only');
      // Serializes retries across processes/devices before testing the unique action key.
      await tx.$queryRaw`SELECT id FROM users WHERE id=${senderId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM push_devices WHERE device_id=${action.deviceId} FOR SHARE`;
      const device = await tx.pushDevice.findFirst({ where: { deviceId: action.deviceId, userId: senderId, enabled: true, token: { not: null },
        user: { deletedAt: null, accountStatus: 'ACTIVE' } } });
      if (!device) throw new ForbiddenError('Notification device is not registered');
    }
    // Lock existing participant rows so removal/deletion cannot race this send.
    await tx.$queryRaw`SELECT user_id FROM conversation_participants WHERE conversation_id=${conversationId} ORDER BY user_id FOR SHARE`;
    const currentMember = await tx.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId: senderId } } });
    if (!currentMember || currentMember.deletedAt) throw new ForbiddenError('Not an active participant');
    const { recipients, isGroup, kind: conversationKind, ownerId } = await recipientsFor(conversationId, senderId, receiverId, tx);
    if (conversationKind === 'CHANNEL' && currentMember.role !== 'ADMIN' && ownerId !== senderId) throw new ForbiddenError('Only channel administrators can post');
    let persistedMediaUrl = options?.mediaUrl ?? null;
    if (options?.type === 'STICKER' && options.stickerId) {
      const sticker = await stickerService.resolveMessageSticker(tx, senderId, options.stickerId);
      persistedMediaUrl = sticker.asset.url;
    }
    const requestHash = action ? createHash('sha256').update(JSON.stringify([
      conversationId, content, receiverId ?? null, options?.repliedToId, action.contractVersion, action.actionId, action.recipientUserId, action.deviceId, action.notificationId,
    ])).digest('hex') : null;
    if (action) {
      const previous = await tx.notificationReplyAction.findUnique({ where: { userId_actionId: { userId: senderId, actionId: action.actionId } } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictError('Action ID was used for another request');
        const existing = await tx.message.findUnique({ where: { id: previous.messageId }, include: messageInclude });
        if (!existing || existing.deletedAt) throw new AppError('Reply is no longer available', 410);
        return { ...serializeMessage(existing), isGroup, readByMe: false };
      }
      await tx.$queryRaw`SELECT id FROM messages WHERE id=${options!.repliedToId!} FOR SHARE`;
      const notification = await tx.pushDelivery.findFirst({ where: { id: action.notificationId,
        device: { deviceId: action.deviceId, userId: senderId }, messageId: options!.repliedToId!,
        message: { conversationId, deletedAt: null, senderId: { not: senderId },
          deletions: { none: { userId: senderId } }, receipts: { some: { userId: senderId } } },
      } });
      if (!notification) throw new ForbiddenError('Notification is not available for this account and conversation');
    }
    if (options?.repliedToId) {
      const original = await tx.message.findUnique({ where: { id: options.repliedToId }, select: { conversationId: true } });
      if (!original || original.conversationId !== conversationId) throw new ValidationError('Invalid reply target');
    }
    // 1. Persist to PostgreSQL
    const message = await tx.message.create({
      data: {
        content: content ?? '',
        fileName: options?.fileName, fileMimeType: options?.fileMimeType,
        fileSize: options?.fileSize, sharedReference: options?.sharedReference,
        mediaUrl: persistedMediaUrl,
        thumbnailUrl: options?.thumbnailUrl ?? null,
        type: options?.type ?? 'TEXT',
        stickerId: options?.stickerId ?? null,
        pinned: options?.pinned ?? false,
        status: 'SENT',
        senderId,
        receiverId: recipients.length === 1 ? recipients[0] : null,
        conversationId,
        duration: options?.duration ?? null,
        repliedToId: options?.repliedToId ?? null,
        forwardedFromId: options?.forwardedFromId ?? null,
        receipts: { create: recipients.map(userId => ({ userId })) },
      },
      include: messageInclude,
    });

    if (options?.type === 'STICKER' && options.stickerId) await stickerService.recordRecent(tx, senderId, options.stickerId);

    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });


    // 2. Publish to Kafka → consumer will emit via Socket.io
    for (const recipientId of recipients) await tx.receiptOutbox.create({ data: { payload: JSON.parse(JSON.stringify({ kind: 'chatMessage', event: {
      message: { ...serializeMessage(message), isGroup, readByMe: false },
      messageId: message.id,
      conversationId,
      senderId,
      senderUsername: message.sender.username,
      senderAvatarUrl: message.sender.avatarUrl,
      receiverId: recipientId,
      isGroup,
      content,
      mediaUrl: message.mediaUrl,
      thumbnailUrl: message.thumbnailUrl,
      type: message.type,
      createdAt: message.createdAt.toISOString(),
      repliedToId: message.repliedToId,
      repliedToContent: message.repliedTo?.content ?? null,
      repliedToSenderId: message.repliedTo?.senderId ?? null,
      repliedToSenderUsername: message.repliedTo?.sender?.username ?? null,
      repliedToType: message.repliedTo?.type ?? null,
    } })) } });

    if (action) await tx.notificationReplyAction.create({ data: {
      userId: senderId, actionId: action.actionId, requestHash: requestHash!, messageId: message.id,
    } });
    await enqueueMessagePush(tx, message.id, recipients);
    if (afterPersist) await afterPersist(tx);
    return { ...serializeMessage(message), isGroup, readByMe: false };
    });
    await publishReceipts().catch(() => logger.error('Message outbox will retry'));
    return result;
  },

  async getChannelPosts(conversationId: string, userId: string, limitInput?: unknown, cursorInput?: string) {
    const channel = await prisma.conversation.findFirst({ where: { id: conversationId, kind: 'CHANNEL' },
      select: { id: true, isPublic: true } });
    if (!channel) throw new NotFoundError('Channel');
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } }, select: { deletedAt: true },
    });
    if (!channel.isPublic && (!participant || participant.deletedAt)) throw new NotFoundError('Channel');

    const limit = boundedLimit(limitInput, 20, 100);
    const cursor = decodeCursor(cursorInput);
    if (cursor) {
      const cursorMessage = await prisma.message.findFirst({ where: {
        id: cursor.id, conversationId, createdAt: cursor.createdAt, deletedAt: null,
        deletions: { none: { userId } },
      }, select: { id: true } });
      if (!cursorMessage) throw new ValidationError('Invalid channel post cursor');
    }
    const baseWhere: Prisma.MessageWhereInput = {
      conversationId, deletedAt: null, deletions: { none: { userId } },
    };
    const where: Prisma.MessageWhereInput = {
      ...baseWhere,
      ...(cursor ? { OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.message.findMany({ where, include: messageInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 }),
      prisma.message.count({ where: baseWhere }),
    ]);
    const hasMore = rows.length > limit;
    const posts = rows.slice(0, limit);
    const last = posts.at(-1);
    return {
      posts: await normalizeMessageMedia(posts.map(serializeMessage)), total, hasMore,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  },

  async updateChannelPost(conversationId: string, postId: string, userId: string, input: { content?: string; pinned?: boolean }) {
    if (input.content !== undefined && (input.content.length < 1 || input.content.length > 5000))
      throw new ValidationError('Post content must be between 1 and 5000 characters');
    if (input.content === undefined && input.pinned === undefined) throw new ValidationError('Provide content or pinned state');
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM conversations WHERE id=${conversationId} FOR UPDATE`;
      const channel = await tx.conversation.findFirst({ where: { id: conversationId, kind: 'CHANNEL' }, select: { id: true, ownerId: true } });
      if (!channel) throw new NotFoundError('Channel');
      await tx.$queryRaw`SELECT id FROM messages WHERE id=${postId} FOR UPDATE`;
      const message = await tx.message.findFirst({ where: { id: postId, conversationId, deletedAt: null } });
      if (!message) throw new NotFoundError('Channel post');
      if (message.type === 'STICKER' && input.content !== undefined) throw new ValidationError('Sticker posts cannot be edited');
      const participant = await tx.conversationParticipant.findUnique({ where: {
        conversationId_userId: { conversationId, userId },
      } });
      if (!participant || participant.deletedAt) throw new ForbiddenError('Not an active channel subscriber');
      const isAdmin = participant.role === 'ADMIN' || channel.ownerId === userId;
      const isAuthor = message.senderId === userId;
      if (input.content !== undefined && !isAdmin && !isAuthor) throw new ForbiddenError('Only the post author or a channel administrator can edit a post');
      if (input.pinned !== undefined && !isAdmin) throw new ForbiddenError('Only channel administrators can pin posts');
      const updatedAt = new Date();
      const result = await tx.message.update({ where: { id: postId }, data: {
        ...(input.content !== undefined ? { content: input.content, editedAt: updatedAt } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      }, include: messageInclude });
      await enqueueDomainEvent(tx, 'messageEdited', {
        messageId: postId, conversationId, content: result.content,
        editedAt: (result.editedAt ?? result.updatedAt).toISOString(),
        ...(input.pinned !== undefined ? { pinned: result.pinned } : {}),
      });
      return result;
    });
    await publishReceipts().catch(error => logger.warn('Channel post update outbox will retry', error));
    return serializeMessage(updated);
  },

  async deleteChannelPost(conversationId: string, postId: string, userId: string) {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM conversations WHERE id=${conversationId} FOR UPDATE`;
      const channel = await tx.conversation.findFirst({ where: { id: conversationId, kind: 'CHANNEL' }, select: { id: true, ownerId: true } });
      if (!channel) throw new NotFoundError('Channel');
      await tx.$queryRaw`SELECT id FROM messages WHERE id=${postId} FOR UPDATE`;
      const message = await tx.message.findFirst({ where: { id: postId, conversationId, deletedAt: null } });
      if (!message) throw new NotFoundError('Channel post');
      const participant = await tx.conversationParticipant.findUnique({ where: {
        conversationId_userId: { conversationId, userId },
      } });
      if (!participant || participant.deletedAt) throw new ForbiddenError('Not an active channel subscriber');
      const isAdmin = participant.role === 'ADMIN' || channel.ownerId === userId;
      if (!isAdmin && message.senderId !== userId) throw new ForbiddenError('Only the post author or a channel administrator can delete a post');
      const deletedAt = new Date();
      await tx.message.update({ where: { id: postId }, data: {
        content: '', mediaUrl: null, thumbnailUrl: null, duration: null, fileName: null,
        fileMimeType: null, fileSize: null, sharedReference: Prisma.JsonNull, stickerId: null,
        pinned: false, deletedAt, deletedBy: userId,
      } });
      await enqueueDomainEvent(tx, 'messageDeleted', {
        messageId: postId, conversationId, deletedAt: deletedAt.toISOString(), deletedBy: userId,
      });
      return { messageId: postId, channelId: conversationId, deletedAt: deletedAt.toISOString() };
    });
    await publishReceipts().catch(error => logger.warn('Channel post deletion outbox will retry', error));
    return result;
  },

  async editMessage(messageId: string, userId: string, newContent: string) {
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id=${messageId} FOR UPDATE`;
      const message = await tx.message.findUnique({ where: { id: messageId } });
      if (!message) throw new NotFoundError('Message');
      const participant = await tx.conversationParticipant.findUnique({ where: {
        conversationId_userId: { conversationId: message.conversationId, userId },
      } });
      if (!participant || participant.deletedAt) throw new ForbiddenError('Not an active participant');
      if (message.deletedAt) throw new ValidationError('Cannot edit deleted message');
      if (message.type === 'STICKER') throw new ValidationError('Sticker messages cannot be edited');
      if (message.senderId !== userId) throw new ForbiddenError('Cannot edit someone else\'s message');

      const result = await tx.message.update({
        where: { id: messageId },
        data: { content: newContent, editedAt: new Date() },
        include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
      });
      await enqueueDomainEvent(tx, 'messageEdited', {
        messageId, conversationId: message.conversationId, content: newContent, editedAt: result.editedAt!.toISOString(),
      });
      return result;
    });
    void publishReceipts().catch(() => logger.warn('Message edit outbox will retry'));
    return updated;
  },

  async requireMember(conversationId: string, userId: string) { await requireMember(conversationId, userId); },

  async deleteMessage(messageId: string, userId: string, deleteFor: 'me' | 'everyone', conversationId?: string) {
    z.enum(['me', 'everyone']).parse(deleteFor);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id=${messageId} FOR UPDATE`;
      const message = await tx.message.findUnique({ where: { id: messageId } });
      if (!message) throw new NotFoundError('Message');
      if (conversationId && message.conversationId !== conversationId) throw new ValidationError('Message is not in conversation');
      const member = await tx.conversationParticipant.findUnique({ where: {
        conversationId_userId: { conversationId: message.conversationId, userId },
      } });
      if (!member || member.deletedAt) throw new ForbiddenError('Not an active participant');
      const now = new Date();
      let event;
      let kind;
      if (deleteFor === 'everyone') {
        if (message.senderId !== userId) throw new ForbiddenError('Only the sender can delete for everyone');
        if (!message.deletedAt) await tx.message.update({ where: { id: messageId }, data: {
          content: '', mediaUrl: null, thumbnailUrl: null, duration: null, fileName: null,
          fileMimeType: null, fileSize: null, sharedReference: Prisma.JsonNull, stickerId: null, pinned: false,
          deletedAt: now, deletedBy: userId,
        } });
        kind = 'messageDeleted';
        event = { messageId, conversationId: message.conversationId, deletedAt: (message.deletedAt ?? now).toISOString(), deletedBy: userId };
      } else {
        await tx.messageDeletion.upsert({ where: { messageId_userId: { messageId, userId } },
          create: { messageId, userId }, update: {} });
        kind = 'messageDeletedForMe';
        event = { messageId, conversationId: message.conversationId, userId };
      }
      await tx.receiptOutbox.create({ data: { payload: { kind, event } } });
      return { messageId, deleteFor };
    });
    await publishReceipts().catch(error => logger.error('Deletion outbox will retry', error));
    return result;
  },

  async deleteMessages(conversationId: string, userId: string, messageIds: string[], deleteFor: 'me' | 'everyone') {
    await requireMember(conversationId, userId);
    const results = [];
    for (const messageId of [...new Set(messageIds)]) {
      try { results.push({ ...await this.deleteMessage(messageId, userId, deleteFor, conversationId), success: true }); }
      catch (error) { results.push({ messageId, success: false, error: (error as Error).message }); }
    }
    return { conversationId, deleteFor, results };
  },

  async markMessagesDelivered(messageIds: string[], userId: string) {
    const messages = await prisma.message.findMany({ where: {
      id: { in: messageIds }, ...eligible(userId),
      receipts: { some: { userId, deliveredAt: null, readAt: null } },
    } });
    const now = new Date();
    await prisma.$transaction(async tx => {
      await tx.message.updateMany({ where: {
        id: { in: messages.map(m => m.id) }, status: { in: ['SENT', 'SENDING'] }, isRead: false,
      }, data: { status: 'DELIVERED', deliveredAt: now } });
      await tx.messageReceipt.updateMany({ where: {
        messageId: { in: messages.map(m => m.id) }, userId, readAt: null, deliveredAt: null,
      }, data: { deliveredAt: now } });
      for (const msg of messages) await tx.receiptOutbox.create({ data: { payload: {
        kind: 'messageDelivered', event: { messageId: msg.id, conversationId: msg.conversationId,
          senderId: msg.senderId, userId, deliveredAt: now.toISOString() },
      } } });
    });
    await publishReceipts().catch(error => logger.error('Delivery outbox will retry', error));
    return messages;
  },

  async markAllMessagesDelivered(userId: string) {
    const messages = await prisma.message.findMany({ where: {
      ...eligible(userId), receipts: { some: { userId, deliveredAt: null, readAt: null } },
    }, select: { id: true } });
    return this.markMessagesDelivered(messages.map(m => m.id), userId);
  },

  async getPendingDeliveryMessages(userId: string, limit = 50) {
    const messages = await prisma.message.findMany({ where: {
      ...eligible(userId), receipts: { some: { userId, deliveredAt: null, readAt: null } },
    }, include: messageInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50 });
    return receiptDTOs(messages, userId);
  },

  async syncReceipts(userId: string, messageIds: string[]) {
    const messages = await prisma.message.findMany({ where: {
      id: { in: messageIds }, senderId: userId, deletions: { none: { userId } },
      conversation: { participants: { some: { userId, deletedAt: null } } },
    }, select: { id: true, conversationId: true, status: true, deletedAt: true, deletedBy: true } });
    return messages.map(({ id, deletedAt, deletedBy, ...rest }) => ({ messageId: id, ...rest, ...(deletedAt ? { deletedAt, deletedBy } : {}) }));
  },

  // Explicit bulk action only; never invoked by visibility or history fetching.
  async markMessagesRead(conversationId: string, userId: string) {
    await requireMember(conversationId, userId);
    const messages = await prisma.message.findMany({ where: {
      conversationId, ...eligible(userId), receipts: { some: { userId, readAt: null } },
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    for (const message of messages) await this.markMessageRead(conversationId, userId, message.id);
    return { lastReadMessageId: messages[0]?.id ?? null, count: messages.length };
  },

  async markMessageRead(conversationId: string, userId: string, messageId: string) {
    const result = await prisma.$transaction(async tx => {
      // Row locking serializes read/delete races and duplicate ACKs.
      await tx.$queryRaw`SELECT id FROM messages WHERE id=${messageId} FOR UPDATE`;
      const participant = await tx.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant || participant.deletedAt) throw new ForbiddenError('Not an active participant');
      const message = await tx.message.findFirst({ where: {
        id: messageId, conversationId, ...eligible(userId),
        receipts: { some: { userId } },
      } });
      if (!message) throw new ForbiddenError('Not an eligible recipient');
      const key = { messageId_userId: { messageId, userId } };
      await tx.messageReceipt.updateMany({ where: { messageId, userId, readAt: null },
        data: { readAt: new Date() } });
      await tx.messageReceipt.updateMany({ where: { messageId, userId, deliveredAt: null }, data: { deliveredAt: new Date() } });
      const receipt = await tx.messageReceipt.findUniqueOrThrow({ where: key });
      await tx.message.update({ where: { id: messageId }, data: { status: 'READ', isRead: true } });
      const payload = { conversationId, messageId, userId, senderId: message.senderId,
        readAt: receipt.readAt!.toISOString() };
      const outbox = await tx.receiptOutbox.create({ data: { payload } });
      return { outboxId: outbox.id, read: true, ...payload };
    });
    // Committed state survives publication failure; the worker retries the intent.
    await publishReceipts(result.outboxId).catch(error => {
      logger.error('Immediate receipt publication failed; committed outbox will retry', error);
    });
    return result;
  },

  async forwardMessage(messageId: string, senderId: string, targetConversationId: string) {
    const original = await prisma.message.findUnique({
      where: { id: messageId },
      include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
    });
    if (!original) throw new NotFoundError('Message');

    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: targetConversationId, userId: senderId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant in target conversation');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    await requireMember(original.conversationId, senderId);
    if (original.deletedAt) throw new ValidationError('Deleted forward target');
    const { recipients } = await recipientsFor(targetConversationId, senderId);
    return this.sendMessage(targetConversationId, senderId, original.content, recipients[0], {
      mediaUrl: original.mediaUrl, thumbnailUrl: original.thumbnailUrl,
      type: original.type, duration: original.duration, forwardedFromId: original.id,
      fileName: original.fileName, fileMimeType: original.fileMimeType, fileSize: original.fileSize,
      sharedReference: original.sharedReference as Prisma.InputJsonValue ?? undefined,
    });
  },

  async getRepliedMessage(messageId: string) {
    return prisma.message.findUnique({
      where: { id: messageId },
      include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
    });
  },

  async replyMessage(
    conversationId: string,
    senderId: string,
    content: string,
    repliedToId: string,
    receiverId?: string,
    options?: {
      notificationAction?: NotificationReplyAction;
      mediaUrl?: string | null;
      thumbnailUrl?: string | null;
      type?: MessageType;
      duration?: number | null;
    }
  ) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant in this conversation');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    const repliedTo = await prisma.message.findUnique({
      where: { id: repliedToId },
      select: { id: true, conversationId: true },
    });
    if (!repliedTo || repliedTo.conversationId !== conversationId) {
      throw new ValidationError('Invalid reply target');
    }

    return this.sendMessage(conversationId, senderId, content, receiverId, { ...options, repliedToId });
  },

  async deleteConversation(conversationId: string, userId: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, kind: true } });
    if (!conversation) throw new NotFoundError('Conversation');
    if (conversation.kind === 'GROUP') return communityService.removeGroupMember(conversationId, userId, userId);
    if (conversation.kind === 'CHANNEL') return communityService.leaveChannel(conversationId, userId);

    const deletedAt = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT conversation_id FROM conversation_participants WHERE conversation_id=${conversationId} AND user_id=${userId} FOR UPDATE`;
      const participant = await tx.conversationParticipant.findUnique({ where: {
        conversationId_userId: { conversationId, userId },
      } });
      if (!participant) throw new NotFoundError('Conversation');
      if (participant.deletedAt) throw new ValidationError('Conversation already deleted');
      const at = new Date();
      await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: { deletedAt: at } });
      await enqueueDomainEvent(tx, 'conversationDeleted', { conversationId, userId, deletedAt: at.toISOString() });
      return at;
    });
    void publishReceipts().catch(() => logger.warn('Conversation deletion outbox will retry'));
    return { conversationId, deletedAt: deletedAt.toISOString() };
  },
};
