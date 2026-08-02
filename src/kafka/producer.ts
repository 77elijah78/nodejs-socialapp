import { Producer, CompressionTypes } from 'kafkajs';
import { kafka, TopicName } from '../config/kafka.js';
import { logger } from '../config/logger.js';

let producer: Producer;

export async function connectProducer(): Promise<void> {
  producer = kafka.producer({
    allowAutoTopicCreation: false,
    transactionTimeout: 30_000,
    idempotent: true,
  });

  await producer.connect();
  logger.info('✅ Kafka producer connected');
}

export async function disconnectProducer(): Promise<void> {
  await producer?.disconnect();
}

export async function publishEvent<T extends object>(
  topic: TopicName,
  payload: T,
  key?: string
): Promise<void> {
  if (!producer) throw new Error('Kafka producer not connected');

  try {
    await producer.send({
      topic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key: key ?? null,
          value: JSON.stringify(payload),
          headers: {
            'content-type': 'application/json',
            'produced-at': new Date().toISOString(),
          },
        },
      ],
    });
  } catch (err) {
    logger.error(`Failed to publish to ${topic}`, err);
    throw err;
  }
}

// ─── Typed event publishers ───────────────────────────────────────

import { TOPICS } from '../config/kafka.js';

export interface ChatMessageEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderUsername: string;
  senderAvatarUrl: string | null;
  receiverId?: string;
  content: string;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  type: string;
  createdAt: string;
}

export interface NotificationEvent {
  userId: string;
  actorId: string;
  type: 'LIKE' | 'COMMENT' | 'FOLLOW' | 'MESSAGE' | 'MENTION';
  content: string;
  resourceId?: string;
}

export interface PresenceEvent {
  userId: string;
  username: string;
  status: 'online' | 'offline';
  timestamp: string;
}

export interface MessageReadEvent {
  conversationId: string;
  userId: string;
  readAt: string;
}

export interface MessageDeliveredEvent {
  conversationId: string;
  messageId: string;
  userId: string;
  deliveredAt: string;
}

export interface MessageEditedEvent {
  conversationId: string;
  messageId: string;
  content: string;
  editedAt: string;
}

export interface MessageDeletedEvent {
  conversationId: string;
  messageId: string;
  deletedAt: string;
  deletedBy: string;
}

export interface MessageDeletedForMeEvent {
  conversationId: string;
  messageId: string;
  userId: string;
}

export const kafkaEvents = {
  chatMessage: (event: ChatMessageEvent) =>
    publishEvent(TOPICS.CHAT_MESSAGES, event, event.conversationId),

  notification: (event: NotificationEvent) =>
    publishEvent(TOPICS.NOTIFICATIONS, event, event.userId),

  presence: (event: PresenceEvent) =>
    publishEvent(TOPICS.PRESENCE, event, event.userId),

   messageRead: (event: MessageReadEvent) =>
    publishEvent(TOPICS.MESSAGE_READ, event, event.conversationId),

   messageDelivered: (event: MessageDeliveredEvent) =>
    publishEvent(TOPICS.CHAT_DELIVERED, event, event.conversationId),

   messageEdited: (event: MessageEditedEvent) =>
    publishEvent(TOPICS.CHAT_EDITED, event, event.conversationId),

   messageDeleted: (event: MessageDeletedEvent) =>
    publishEvent(TOPICS.CHAT_DELETED, event, event.conversationId),

   messageDeletedForMe: (event: MessageDeletedForMeEvent) =>
    publishEvent(TOPICS.CHAT_DELETED_FOR_ME, event, event.userId),
};
