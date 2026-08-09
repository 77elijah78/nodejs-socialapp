import { prisma } from '../config/database.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { kafkaEvents } from '../kafka/producer.js';
import { MessageStatus } from '../types/index.js';

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
    return prisma.conversation.findMany({
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
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });
  },

  async getMessages(conversationId: string, userId: string, page: number, limit: number) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant in this conversation');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId },
        include: {
          sender: { select: { id: true, username: true, avatarUrl: true } },
          repliedTo: {
            select: {
              id: true,
              content: true,
              senderId: true,
              type: true,
              sender: { select: { username: true, avatarUrl: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.message.count({ where: { conversationId } }),
    ]);

    const lastMessage = messages[messages.length - 1];

    // Mark read + publish Kafka event
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });

    await kafkaEvents.messageRead({
      conversationId,
      userId,
      messageId: lastMessage?.id,
      senderId: lastMessage?.senderId,
      readAt: new Date().toISOString(),
    });

    return { messages: messages.reverse(), total };
  },

  async sendMessage(
    conversationId: string,
    senderId: string,
    content: string,
    receiverId?: string,
    options?: {
      type?: MessageStatus;
      mediaUrl?: string | null;
      thumbnailUrl?: string | null;
      duration?: number | null;
      repliedToId?: string | null;
      forwardedFromId?: string | null;
    }
  ) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant in this conversation');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    // 1. Persist to PostgreSQL
    const message = await prisma.message.create({
      data: {
        content,
        mediaUrl: options?.mediaUrl ?? null,
        thumbnailUrl: options?.thumbnailUrl ?? null,
        type: (options?.type as any) ?? 'TEXT',
        status: 'SENT',
        senderId,
        receiverId: receiverId ?? null,
        conversationId,
        duration: options?.duration ?? null,
        repliedToId: options?.repliedToId ?? null,
        forwardedFromId: options?.forwardedFromId ?? null,
      },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
        repliedTo: {
          select: {
            id: true,
            content: true,
            senderId: true,
            type: true,
            sender: { select: { username: true, avatarUrl: true } },
          },
        },
      },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // 2. Publish to Kafka → consumer will emit via Socket.io
    await kafkaEvents.chatMessage({
      messageId: message.id,
      conversationId,
      senderId,
      senderUsername: message.sender.username,
      senderAvatarUrl: message.sender.avatarUrl,
      receiverId,
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
    });

    return message;
  },

  async editMessage(messageId: string, userId: string, newContent: string) {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundError('Message');
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

  async deleteMessage(messageId: string, userId: string, deleteFor: 'me' | 'everyone') {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundError('Message');
    if (message.senderId !== userId) throw new ForbiddenError('Cannot delete someone else\'s message');

    const now = new Date();

    if (deleteFor === 'everyone') {
      // Hard delete for everyone — replace content with tombstone
      await prisma.message.update({
        where: { id: messageId },
        data: {
          content: '',
          mediaUrl: null,
          deletedAt: now,
          deletedBy: userId,
        },
      });
      await kafkaEvents.messageDeleted({
        messageId,
        conversationId: message.conversationId,
        deletedAt: now.toISOString(),
        deletedBy: userId,
      });
    } else {
      // Soft-delete for sender only — keep in DB but notify client
      await kafkaEvents.messageDeletedForMe({
        messageId,
        conversationId: message.conversationId,
        userId,
      });
    }

    return { messageId, deleteFor };
  },

  async markMessagesDelivered(messageIds: string[], userId: string) {
    const messages = await prisma.message.findMany({
      where: {
        id: { in: messageIds },
        receiverId: userId,
        status: { in: ['SENT', 'SENDING'] },
      },
      select: { id: true, conversationId: true, senderId: true },
    });

    await prisma.message.updateMany({
      where: {
        id: { in: messageIds },
        receiverId: userId,
        status: { in: ['SENT', 'SENDING'] },
      },
      data: { status: 'DELIVERED' as any, deliveredAt: new Date() },
    });

    for (const msg of messages) {
      await kafkaEvents.messageDelivered({
        messageId: msg.id,
        conversationId: msg.conversationId,
        userId,
        senderId: msg.senderId,
        deliveredAt: new Date().toISOString(),
      });
    }

    return messages;
  },

  async markMessagesDeliveredByConversation(conversationId: string, userId: string) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        receiverId: userId,
        status: { in: ['SENT', 'SENDING'] },
      },
      select: { id: true, conversationId: true, senderId: true },
    });

    if (messages.length === 0) {
      return [];
    }

    await prisma.message.updateMany({
      where: {
        conversationId,
        receiverId: userId,
        status: { in: ['SENT', 'SENDING'] },
      },
      data: { status: 'DELIVERED' as any, deliveredAt: new Date() },
    });

    for (const msg of messages) {
      await kafkaEvents.messageDelivered({
        messageId: msg.id,
        conversationId: msg.conversationId,
        userId,
        senderId: msg.senderId,
        deliveredAt: new Date().toISOString(),
      });
    }

    return messages;
  },

  async markAllMessagesDelivered(userId: string) {
    const conversations = await prisma.conversationParticipant.findMany({
      where: { userId, deletedAt: null },
      select: { conversationId: true },
    });

    const conversationIds = conversations.map(c => c.conversationId);

    const messages = await prisma.message.findMany({
      where: {
        conversationId: { in: conversationIds },
        receiverId: userId,
        status: { in: ['SENT', 'SENDING'] },
      },
      select: { id: true, conversationId: true, senderId: true },
    });

    if (messages.length === 0) {
      return [];
    }

    await prisma.message.updateMany({
      where: {
        id: { in: messages.map(m => m.id) },
      },
      data: { status: 'DELIVERED' as any, deliveredAt: new Date() },
    });

    for (const msg of messages) {
      await kafkaEvents.messageDelivered({
        messageId: msg.id,
        conversationId: msg.conversationId,
        userId,
        senderId: msg.senderId,
        deliveredAt: new Date().toISOString(),
      });
    }

    return messages;
  },

  async markMessagesRead(conversationId: string, userId: string) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    const unreadMessages = await prisma.message.findMany({
      where: {
        conversationId,
        receiverId: userId,
        isRead: false,
      },
      select: { id: true, senderId: true },
      orderBy: { createdAt: 'desc' },
    });

    await prisma.message.updateMany({
      where: {
        conversationId,
        receiverId: userId,
        isRead: false,
      },
      data: { isRead: true, status: 'READ' as any },
    });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });

    for (const msg of unreadMessages) {
      await kafkaEvents.messageRead({
        conversationId,
        userId,
        messageId: msg.id,
        senderId: msg.senderId,
        readAt: new Date().toISOString(),
      });
    }

    return {
      lastReadMessageId: unreadMessages[0]?.id ?? null,
      count: unreadMessages.length,
    };
  },

  async markMessageRead(conversationId: string, userId: string, messageId: string) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) throw new ForbiddenError('Not a participant');
    if (participant.deletedAt) throw new ForbiddenError('You have deleted this conversation');

    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        receiverId: userId,
        isRead: false,
      },
      select: { id: true, senderId: true },
    });

    if (!message) {
      return { read: false };
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { isRead: true, status: 'READ' as any },
    });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });

    await kafkaEvents.messageRead({
      conversationId,
      userId,
      messageId: message.id,
      senderId: message.senderId,
      readAt: new Date().toISOString(),
    });

    return { read: true };
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

    const forwarded = await prisma.message.create({
      data: {
        content: original.content,
        mediaUrl: original.mediaUrl,
        thumbnailUrl: original.thumbnailUrl,
        type: original.type,
        status: 'SENT',
        senderId,
        conversationId: targetConversationId,
        duration: original.duration,
        forwardedFromId: original.id,
      },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
      },
    });

    await prisma.conversation.update({
      where: { id: targetConversationId },
      data: { updatedAt: new Date() },
    });

    return forwarded;
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
      type?: MessageStatus;
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

    const message = await prisma.message.create({
      data: {
        content,
        mediaUrl: options?.mediaUrl ?? null,
        thumbnailUrl: options?.thumbnailUrl ?? null,
        type: (options?.type as any) ?? 'TEXT',
        status: 'SENT',
        senderId,
        receiverId: receiverId ?? null,
        conversationId,
        repliedToId,
        duration: options?.duration ?? null,
      },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
        repliedTo: {
          select: {
            id: true,
            content: true,
            senderId: true,
            type: true,
            sender: { select: { username: true, avatarUrl: true } },
          },
        },
      },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    await kafkaEvents.chatMessage({
      messageId: message.id,
      conversationId,
      senderId,
      senderUsername: message.sender.username,
      senderAvatarUrl: message.sender.avatarUrl,
      receiverId,
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
    });

    return message;
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
