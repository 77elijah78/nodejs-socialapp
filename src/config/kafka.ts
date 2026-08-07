import { Kafka, logLevel } from 'kafkajs';
import { logger } from './logger.js';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');

export const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID ?? 'social-backend',
  brokers,
  logLevel: logLevel.WARN,
  logCreator: () => ({ namespace, level, label, log }) => {
    const { message, ...rest } = log;
    logger.log({
      level: level <= logLevel.ERROR ? 'error' : level <= logLevel.WARN ? 'warn' : 'debug',
      message: `[Kafka:${namespace}] ${message}`,
      ...rest,
    });
  },
  retry: {
    initialRetryTime: 300,
    retries: 8,
  },
});

// ─── Topic constants ─────────────────────────────────────────────
export const TOPICS = {
  CHAT_MESSAGES:        'chat.messages',
  CHAT_DELIVERED:       'chat.delivered',
  CHAT_EDITED:          'chat.edited',
  CHAT_DELETED:         'chat.deleted',
  CHAT_DELETED_FOR_ME:  'chat.deleted-for-me',
  CONVERSATION_DELETED: 'chat.conversation-deleted',
  NOTIFICATIONS:        'chat.notifications',
  PRESENCE:             'chat.presence',
  MESSAGE_READ:         'chat.message-read',
} as const;

export type TopicName = typeof TOPICS[keyof typeof TOPICS];
