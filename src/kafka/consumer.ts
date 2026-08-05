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

  await consumer.run({
    eachBatchAutoResolve: true,
    eachMessage: async ({ topic, message }: EachMessagePayload) => {
      if (!message.value) return;

      try {
        const payload = JSON.parse(message.value.toString());
        await routeEvent(io, topic, payload);
      } catch (err) {
        logger.error(`Consumer error [${topic}]`, err);
      }
    },
  });

  logger.info('✅ Kafka consumer connected and listening');
}

export async function disconnectConsumer(): Promise<void> {
  await consumer?.disconnect();
}

// ─── Event router ─────────────────────────────────────────────────

async function routeEvent(io: Server, topic: string, payload: unknown): Promise<void> {
  switch (topic) {
    case TOPICS.CHAT_MESSAGES:
      handleChatMessage(io, payload as ChatMessageEvent);
      break;

    case TOPICS.CHAT_DELIVERED:
      handleMessageDelivered(io, payload as MessageDeliveredEvent);
      break;

    case TOPICS.CHAT_EDITED:
      handleMessageEdited(io, payload as MessageEditedEvent);
      break;

    case TOPICS.CHAT_DELETED:
      handleMessageDeleted(io, payload as MessageDeletedEvent);
      break;

    case TOPICS.CHAT_DELETED_FOR_ME:
      handleMessageDeletedForMe(io, payload as MessageDeletedForMeEvent);
      break;

    case TOPICS.NOTIFICATIONS:
      handleNotification(io, payload as NotificationEvent);
      break;

    case TOPICS.PRESENCE:
      handlePresence(io, payload as PresenceEvent);
      break;

    case TOPICS.MESSAGE_READ:
      handleMessageRead(io, payload as MessageReadEvent);
      break;

    default:
      logger.warn(`Unhandled topic: ${topic}`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────

function handleChatMessage(io: Server, event: ChatMessageEvent): void {
  // Emit to everyone in the conversation room
  io.to(`conversation:${event.conversationId}`).emit('message:new', {
    id: event.messageId,
    content: event.content,
    conversationId: event.conversationId,
    receiverId: event.receiverId,
    mediaUrl: event.mediaUrl ?? null,
    thumbnailUrl: event.thumbnailUrl ?? null,
    type: event.type,
    createdAt: event.createdAt,
    sender: {
      id: event.senderId,
      username: event.senderUsername,
      avatarUrl: event.senderAvatarUrl,
    },
  });

  // Push notification to receiver's personal room (if they're not in the chat room)
  if (event.receiverId) {
    io.to(`user:${event.receiverId}`).emit('message:notification', {
      conversationId: event.conversationId,
      senderId: event.senderId,
      sender: {
        username: event.senderUsername,
        avatarUrl: event.senderAvatarUrl,
      },
      content: event.content,
      mediaUrl: event.mediaUrl ?? null,
      thumbnailUrl: event.thumbnailUrl ?? null,
      type: event.type,
      createdAt: event.createdAt,
    });
  }

  logger.debug(
    `[Kafka→WS] chat.messages → conversation:${event.conversationId}`
  );
}

function handleMessageDelivered(io: Server, event: MessageDeliveredEvent): void {
  io.to(`conversation:${event.conversationId}`).emit('message:delivered', {
    messageId: event.messageId,
    conversationId: event.conversationId,
    userId: event.userId,
    deliveredAt: event.deliveredAt,
  });

  logger.debug(
    `[Kafka→WS] chat.delivered → conversation:${event.conversationId}`
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

function handleMessageDeleted(io: Server, event: MessageDeletedEvent): void {
  io.to(`conversation:${event.conversationId}`).emit('message:deleted', {
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

function handleNotification(io: Server, event: NotificationEvent): void {
  io.to(`user:${event.userId}`).emit('notification:new', {
    type: event.type,
    content: event.content,
    actorId: event.actorId,
    resourceId: event.resourceId,
  });

  logger.debug(`[Kafka→WS] notifications → user:${event.userId}`);
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

function handleMessageRead(io: Server, event: MessageReadEvent): void {
  io.to(`conversation:${event.conversationId}`).emit('message:read', {
    conversationId: event.conversationId,
    userId: event.userId,
    readAt: event.readAt,
  });

  logger.debug(
    `[Kafka→WS] message-read → conversation:${event.conversationId}`
  );
}
