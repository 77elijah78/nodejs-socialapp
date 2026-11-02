import { emitMessageOnce } from '../services/delivery-state.service.js';
import { activityService } from '../services/activity.service.js';
import { messageInclude, serializeMessage } from '../services/message.dto.js';
import { prisma } from '../config/database.js';
import { z } from 'zod';
import { Consumer, EachMessagePayload } from 'kafkajs';
import { Server } from 'socket.io';
import { kafka, TOPICS } from '../config/kafka.js';
import { logger } from '../config/logger.js';
import type {
  ChatMessageEvent,
  NotificationEvent,
  PresenceEvent,
  MessageReadEvent,
  MessageDeliveredEvent,
  MessageEditedEvent,
  MessageDeletedEvent,
  MessageDeletedForMeEvent,
  ConversationDeletedEvent,
} from './producer.js';

let consumer: Consumer;

export async function connectConsumer(io: Server): Promise<void> {
  consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID ?? 'social-backend-group',
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
    maxBytesPerPartition: 1_048_576, // 1MB
  });

  await consumer.connect();

  // Subscribe to all topics
  await consumer.subscribe({
    topics: Object.values(TOPICS),
    fromBeginning: false,
  });

  consumer.on(consumer.events.GROUP_JOIN, () => {
    io.local.emit('receipts:resync');
    io.local.emit('notifications:sync', { reason: 'consumer-rejoined' });
    io.local.emit('messages:sync', { reason: 'consumer-rejoined' });
  });
  await consumer.run({
    eachBatchAutoResolve: true,
    eachMessage: async ({ topic, message }: EachMessagePayload) => {
      if (!message.value) return;

      try {
        const payload = JSON.parse(message.value.toString());
        await routeEvent(io, topic, payload);
      } catch (err) {
        logger.error(`Consumer error [${topic}]`);
        throw err;
      }
    },
  });

  logger.info('✅ Kafka consumer connected and listening');
}

export async function disconnectConsumer(): Promise<void> {
  await consumer?.disconnect();
}

// ─── Event router ─────────────────────────────────────────────────

export async function routeEvent(io: Server, topic: string, payload: unknown): Promise<void> {
  switch (topic) {
    case TOPICS.CHAT_MESSAGES:
      await handleChatMessage(io, payload as ChatMessageEvent);
      break;

    case TOPICS.CHAT_DELIVERED:
      handleMessageDelivered(io, payload as MessageDeliveredEvent);
      break;

    case TOPICS.CHAT_EDITED:
      handleMessageEdited(io, payload as MessageEditedEvent);
      break;

    case TOPICS.CHAT_DELETED:
      await handleMessageDeleted(io, payload as MessageDeletedEvent);
      break;

    case TOPICS.CHAT_DELETED_FOR_ME:
      handleMessageDeletedForMe(io, payload as MessageDeletedForMeEvent);
      break;

    case TOPICS.NOTIFICATIONS:
      await handleNotification(io, payload as NotificationEvent);
      break;

    case TOPICS.PRESENCE:
      handlePresence(io, payload as PresenceEvent);
      break;

    case TOPICS.MESSAGE_READ:
      handleMessageRead(io, payload as MessageReadEvent);
      break;

    case TOPICS.CONVERSATION_DELETED:
      handleConversationDeleted(io, payload as ConversationDeletedEvent);
      break;

    default:
      logger.warn(`Unhandled topic: ${topic}`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────

const messageRoutingSchema = z.object({ messageId: z.string().uuid(), conversationId: z.string().uuid(), senderId: z.string().uuid(), receiverId: z.string().uuid() });
async function handleChatMessage(io: Server, payload: ChatMessageEvent): Promise<void> {
  const event = messageRoutingSchema.parse(payload);
  if (event.senderId === event.receiverId) return;
  const current = await prisma.message.findFirst({ where: { id: event.messageId, conversationId: event.conversationId,
    senderId: event.senderId, deletions: { none: { userId: event.receiverId } },
    receipts: { some: { userId: event.receiverId } },
    conversation: { participants: { some: { userId: event.receiverId, deletedAt: null, user: { accountStatus: 'ACTIVE', deletedAt: null } } } },
  }, include: { ...messageInclude, conversation: { select: { isGroup: true } },
    receipts: { where: { userId: event.receiverId }, select: { readAt: true } } } });
  if (!current) return;
  const { receipts, conversation, ...message } = current;
  const messagePayload = { ...serializeMessage(message), messageId: message.id,
    isGroup: conversation.isGroup, readByMe: !!receipts[0]?.readAt, timestamp: message.createdAt.getTime() };
  await emitMessageOnce(event.messageId, event.receiverId, () => {
    io.to(`user:${event.receiverId}`).emit('message:new', messagePayload);
    // Legacy banner event remains; now carries the same complete DTO.
    io.to(`user:${event.receiverId}`).emit('message:notification', messagePayload);
  });
}

function handleMessageDelivered(io: Server, event: MessageDeliveredEvent): void {
  io.to(`user:${event.senderId}`).emit('message:delivered', {
    messageId: event.messageId,
    conversationId: event.conversationId,
    userId: event.userId,
    deliveredAt: event.deliveredAt,
  });

  logger.debug(
    `[Kafka→WS] chat.delivered → user:${event.senderId} message:${event.messageId}`
  );
}

function handleMessageEdited(io: Server, event: MessageEditedEvent): void {
  io.to(`conversation:${event.conversationId}`).emit('message:edited', {
    messageId: event.messageId,
    conversationId: event.conversationId,
    content: event.content,
    editedAt: event.editedAt,
  });

  logger.debug(
    `[Kafka→WS] chat.edited → conversation:${event.conversationId}`
  );
}

async function handleMessageDeleted(io: Server, event: MessageDeletedEvent): Promise<void> {
  const participants = await prisma.conversationParticipant.findMany({ where: { conversationId: event.conversationId, deletedAt: null }, select: { userId: true } });
  io.to(participants.map(p => `user:${p.userId}`)).emit('message:deleted', {
    messageId: event.messageId,
    conversationId: event.conversationId,
    deletedAt: event.deletedAt,
    deletedBy: event.deletedBy,
  });

  logger.debug(
    `[Kafka→WS] chat.deleted → conversation:${event.conversationId}`
  );
}

function handleMessageDeletedForMe(io: Server, event: MessageDeletedForMeEvent): void {
  io.to(`user:${event.userId}`).emit('message:deleted-for-me', {
    messageId: event.messageId,
    conversationId: event.conversationId,
  });

  logger.debug(
    `[Kafka→WS] chat.deleted-for-me → user:${event.userId}`
  );
}

const notificationEventSchema = z.object({
  id: z.string().uuid().optional(), userId: z.string().uuid(),
  actorId: z.string().uuid().nullable().optional(),
  type: z.enum(['LIKE', 'COMMENT', 'FOLLOW', 'MESSAGE', 'MENTION', 'SHARE']).optional(),
  resourceId: z.string().optional(), operation: z.enum(['updated', 'sync']).optional(),
}).refine(e => e.operation === 'sync' || !!e.type, { message: 'Notification type is required' })
  .refine(e => e.operation === 'sync' || !!e.id || !!e.actorId, { message: 'Notification identity is required' });
async function handleNotification(io: Server, payload: NotificationEvent): Promise<void> {
  const event = notificationEventSchema.parse(payload);
  if (event.operation === 'sync') {
    const recipient = await prisma.user.findFirst({ where: { id: event.userId, accountStatus: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (recipient) io.to(`user:${event.userId}`).emit('notifications:sync', { reason: 'state-changed' });
    return;
  }
  // Old rolling-deployment events may omit ID. Resolve only an existing persisted
  // notification; never manufacture another record from Kafka delivery.
  const row = await prisma.notification.findFirst({ where: {
    ...(event.id ? { id: event.id } : { actorId: event.actorId, type: event.type,
      resourceId: event.resourceId ?? null }), userId: event.userId,
    user: { accountStatus: 'ACTIVE', deletedAt: null },
  }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!row) return;
  if (row.dismissedAt || row.withdrawnAt) {
    if (event.operation === 'updated') io.to(`user:${event.userId}`).emit('notification:removed', {
      id: row.id, version: row.version, reason: row.dismissedAt ? 'dismissed' : 'withdrawn',
    });
    return;
  }
  const notification = await activityService.forDelivery(event.userId, row.id);
  if (!notification) return;
  io.to(`user:${event.userId}`).emit('notification:new', notification);
}

function handlePresence(io: Server, event: PresenceEvent): void {
  const wsEvent = event.status === 'online' ? 'presence:online' : 'presence:offline';
  io.emit(wsEvent, {
    userId: event.userId,
    username: event.username,
    timestamp: event.timestamp,
  });

  logger.debug(`[Kafka→WS] presence → ${event.status} ${event.username}`);
}

const receiptEventSchema = z.object({
  conversationId: z.string().uuid(), messageId: z.string().uuid(),
  senderId: z.string().uuid(), userId: z.string().uuid(), readAt: z.string().datetime(),
});

export function handleMessageRead(io: Server, event: MessageReadEvent): void {
  // Malformed receipt records fail processing; never silently commit their offset.
  const receipt = receiptEventSchema.parse(event);
  io.to([`user:${receipt.senderId}`, `user:${receipt.userId}`]).emit('message:read', {
    conversationId: receipt.conversationId,
    userId: receipt.userId,
    messageId: receipt.messageId,
    readAt: receipt.readAt,
  });
}

function handleConversationDeleted(io: Server, event: ConversationDeletedEvent): void {
  // Notify anyone in the conversation room that this conversation was deleted by a participant
  io.to(`conversation:${event.conversationId}`).emit('conversation:deleted', {
    conversationId: event.conversationId,
    userId: event.userId,
    deletedAt: event.deletedAt,
  });

  logger.debug(
    `[Kafka→WS] conversation-deleted → conversation:${event.conversationId}`
  );
}
