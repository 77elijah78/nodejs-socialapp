import { isSharedMediaUrl } from '../config/media.js';
import { z } from 'zod';
import { messageInclude, serializeMessage } from './message.dto.js';
import { prisma } from '../config/database.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { kafkaEvents } from '../kafka/producer.js';
import { logger } from '../config/logger.js';
import { publishReceipts } from './receipt-outbox.service.js';
import { Prisma, type MessageType } from '@prisma/client';


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
async function recipientsFor(conversationId: string, senderId: string, receiverId?: string) {
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId },
    include: { participants: { where: { deletedAt: null } } } });
  const recipients = conversation.participants.filter(p => p.userId !== senderId).map(p => p.userId);
  if (!recipients.length || (receiverId && !recipients.includes(receiverId)) ||
    (!conversation.isGroup && recipients.length !== 1)) throw new ValidationError('Invalid recipients');
  return { recipients, isGroup: conversation.isGroup };
}
async function receiptDTOs<T extends { id: string; conversationId: string; deletedAt?: Date | null }>(messages: T[], userId: string) {
  const [receipts, conversations] = await Promise.all([
    prisma.messageReceipt.findMany({ where: { userId, messageId: { in: messages.map(m => m.id) } } }),
    prisma.conversation.findMany({ where: { id: { in: messages.map(m => m.conversationId) } }, select: { id: true, isGroup: true } }),
  ]);
  return messages.map(m => ({ ...serializeMessage(m), isGroup: conversations.find(c => c.id === m.conversationId)?.isGroup ?? false,
    readByMe: !!receipts.find(r => r.messageId === m.id)?.readAt }));
}

export const messageService = {
  async getOrCreateConversation(userAId: string, userBId: string) {
    if (userAId === userBId) {
      throw new ValidationError('Cannot create a conversation with yourself');
    }

    // Find existing active DM where BOTH users are participants AND neither has deleted it
    const existing = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
        participants: {
          none: { deletedAt: { not: null } },
        },
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
        },
      },
    });

    if (existing) return existing;

    // If a conversation between these two users exists but one party deleted it,
    // hard-delete the stale one and create a fresh conversation
    const stale = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
      },
    });

    if (stale) {
      await prisma.conversation.delete({ where: { id: stale.id } });
    }

    return prisma.conversation.create({
      data: {
        isGroup: false,
        participants: {
          create: [{ userId: userAId }, { userId: userBId }],
        },
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
        },
      },
    });
  },

  async getUserConversations(userId: string) {
    const conversations = await prisma.conversation.findMany({
      where: {
        participants: { some: { userId, deletedAt: null } },
      },
      include: {
        participants: {
          where: { deletedAt: null },
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
        messages: { where: { deletions: { none: { userId } } }, include: messageInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(conversations.map(async conversation => ({ ...conversation, messages: conversation.messages.map(serializeMessage),
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
    }
  ) {
    for (const url of [options?.mediaUrl, options?.thumbnailUrl]) if (url && !isSharedMediaUrl(url)) throw new ValidationError('Invalid shared media URL');
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
    const { recipients, isGroup } = await recipientsFor(conversationId, senderId, receiverId);
    if (options?.repliedToId) {
      const original = await prisma.message.findUnique({ where: { id: options.repliedToId }, select: { conversationId: true } });
      if (!original || original.conversationId !== conversationId) throw new ValidationError('Invalid reply target');
    }
    // Message, receipts and publication intents commit together.
    const result = await prisma.$transaction(async tx => {
    // 1. Persist to PostgreSQL
    const message = await tx.message.create({
      data: {
        content: content ?? '',
        fileName: options?.fileName, fileMimeType: options?.fileMimeType,
        fileSize: options?.fileSize, sharedReference: options?.sharedReference,
        mediaUrl: options?.mediaUrl ?? null,
        thumbnailUrl: options?.thumbnailUrl ?? null,
        type: options?.type ?? 'TEXT',
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

    return { ...serializeMessage(message), isGroup, readByMe: false };
    });
    await publishReceipts().catch(error => logger.error('Message outbox will retry', error));
    return result;
  },

  async editMessage(messageId: string, userId: string, newContent: string) {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundError('Message');
    await requireMember(message.conversationId, userId);
    if (message.deletedAt) throw new ValidationError('Cannot edit deleted message');
    if (message.senderId !== userId) throw new ForbiddenError('Cannot edit someone else\'s message');

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content: newContent, editedAt: new Date() },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
      },
    });

    // Notify conversation room via socket (emit through Kafka)
    await kafkaEvents.messageEdited({
      messageId,
      conversationId: message.conversationId,
      content: newContent,
      editedAt: updated.editedAt!.toISOString(),
    });

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
          fileMimeType: null, fileSize: null, sharedReference: Prisma.JsonNull,
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
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) throw new NotFoundError('Conversation');

    if (participant.deletedAt) {
      throw new ValidationError('Conversation already deleted');
    }

    const now = new Date();
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { deletedAt: now },
    });

    await kafkaEvents.conversationDeleted({
      conversationId,
      userId,
      deletedAt: now.toISOString(),
    });

    return { conversationId, deletedAt: now.toISOString() };
  },
};
