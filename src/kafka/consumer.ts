import { Consumer, EachMessagePayload } from 'kafkajs';
import { Server } from 'socket.io';
import { kafka, TOPICS } from '../config/kafka.js';
import { logger } from '../config/logger.js';
import { messageService } from '../services/message.service.js';
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

    case TOPICS.CONVERSATION_DELETED:
      handleConversationDeleted(io, payload as ConversationDeletedEvent);
      break;

    default:
      logger.warn(`Unhandled topic: ${topic}`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────

function handleChatMessage(io: Server, event: ChatMessageEvent): void {
  if (!event.receiverId) {
    logger.error(`[Kafka→WS] chat.messages missing receiverId`, {
      messageId: event.messageId,
      conversationId: event.conversationId,
    });
    return;
  }

  const replyData = event.repliedToId
    ? {
        id: event.repliedToId,
        content: event.repliedToContent,
        senderId: event.repliedToSenderId,
        senderUsername: event.repliedToSenderUsername,
        type: event.repliedToType,
      }
    : null;

  const messagePayload = {
    id: event.messageId,
    messageId: event.messageId,
    conversationId: event.conversationId,
    senderId: event.senderId,
    receiverId: event.receiverId,
    content: event.content,
    mediaUrl: event.mediaUrl ?? null,
    thumbnailUrl: event.thumbnailUrl ?? null,
    type: event.type,
    createdAt: event.createdAt,
    timestamp: new Date(event.createdAt).getTime(),
    repliedTo: replyData,
    sender: {
      id: event.senderId,
      username: event.senderUsername,
      avatarUrl: event.senderAvatarUrl,
    },
  };

  io.to(`user:${event.receiverId}`).emit('message:new', messagePayload);

  io.to(`user:${event.receiverId}`).emit('message:notification', {
    id: event.messageId,
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
    repliedTo: replyData,
  });

  logger.debug(
    `[Kafka→WS] chat.messages → user:${event.receiverId} message:${event.messageId}`
  );
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
  if (event.senderId) {
    io.to(`user:${event.senderId}`).emit('message:read', {
      conversationId: event.conversationId,
      userId: event.userId,
      messageId: event.messageId,
      readAt: event.readAt,
    });
  }

  logger.debug(
    `[Kafka→WS] message-read → user:${event.senderId} conversation:${event.conversationId}`
  );
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
