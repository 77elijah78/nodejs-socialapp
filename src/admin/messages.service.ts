import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { kafkaEvents } from '../kafka/producer.js';
import { createAuditLog } from './audit.js';
import { AdminContext } from './types.js';
import { buildSearchMode, clamp, parseDate, parseNumber } from './helpers.js';

export const adminMessagesService = {
  async listConversations(query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.ConversationWhereInput = {
      AND: [
        search
          ? {
              OR: [
                { groupName: { contains: search, mode: 'insensitive' as const } },
                { participants: { some: { user: { username: { contains: search, mode: 'insensitive' as const } } } } },
                { participants: { some: { user: { displayName: { contains: search, mode: 'insensitive' as const } } } } },
              ],
            }
          : {},
        from || to
          ? {
              updatedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          participants: {
            where: { deletedAt: null },
            include: {
              user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              type: true,
              createdAt: true,
              senderId: true,
              receiverId: true,
              deletedAt: true,
              content: true,
            },
          },
          _count: { select: { messages: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    return {
      items: items.map((conversation: any) => ({
        ...conversation,
        lastMessage: conversation.messages[0]
          ? {
              ...conversation.messages[0],
              contentPreview: conversation.messages[0].content.slice(0, 120),
            }
          : null,
      })),
      total,
      page,
      limit,
    };
  },

  async searchMessages(query: Record<string, unknown>, reason: string, admin: AdminContext) {
    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('A clear access reason is required to search private message content');
    }

    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const senderId = typeof query.senderId === 'string' ? query.senderId : undefined;
    const recipientId = typeof query.recipientId === 'string' ? query.recipientId : undefined;
    const conversationId = typeof query.conversationId === 'string' ? query.conversationId : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.MessageWhereInput = {
      AND: [
        search ? { content: { contains: search, mode: 'insensitive' as const } } : {},
        senderId ? { senderId } : {},
        recipientId ? { receiverId: recipientId } : {},
        conversationId ? { conversationId } : {},
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.message.findMany({
        where,
        include: {
          sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          conversation: {
            include: {
              participants: {
                include: { user: { select: { id: true, username: true, displayName: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'PRIVATE_MESSAGE_SEARCHED',
      targetType: 'MESSAGE_SEARCH',
      reason,
      metadata: {
        search,
        senderId,
        recipientId,
        conversationId,
        resultCount: items.length,
      },
    });

    return { items, total, page, limit };
  },

  async getConversationMessages(conversationId: string, reason: string, admin: AdminContext, query: Record<string, unknown>) {
    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('A clear access reason is required to access private messages');
    }

    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 50), 1, 100);

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true, email: true } },
          },
        },
      },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId },
        include: {
          sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          repliedTo: { select: { id: true, content: true, senderId: true, type: true } },
          forwardedFrom: { select: { id: true, content: true, senderId: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.message.count({ where: { conversationId } }),
    ]);

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'PRIVATE_MESSAGE_ACCESSED',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      reason,
      metadata: {
        participantIds: conversation.participants.map((participant) => participant.userId),
        page,
        limit,
      },
    });

    return { conversation, messages, total, page, limit };
  },

  async removeMessage(messageId: string, reason: string, admin: AdminContext) {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundError('Message');

    const now = new Date();

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: '',
        mediaUrl: null,
        thumbnailUrl: null,
        deletedAt: now,
        deletedBy: admin.account.userId,
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    await kafkaEvents.messageDeleted({
      messageId: updated.id,
      conversationId: updated.conversationId,
      deletedAt: now.toISOString(),
      deletedBy: admin.account.userId,
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'MESSAGE_REMOVED',
      targetType: 'MESSAGE',
      targetId: messageId,
      reason,
      metadata: {
        conversationId: updated.conversationId,
        senderId: updated.senderId,
        receiverId: updated.receiverId,
      },
    });

    return updated;
  },
};
