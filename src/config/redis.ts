import { Redis } from 'ioredis';
import { logger } from './logger.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const createRedisClient = (name: string) => {
  const client = new Redis(redisUrl, {
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: null,
  });

  client.on('connect', () => logger.info(`✅ Redis [${name}] connected`));
  client.on('error', (err) => logger.error(`Redis [${name}] error`, err));

  return client;
};

// Two clients needed for Socket.io pub/sub adapter
export const pubClient  = createRedisClient('pub');
export const subClient  = createRedisClient('sub');
export const redisClient = createRedisClient('main');

// Bounded fail-open presence/dedup operations must not block message delivery.
export const deliveryRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 1000,
  connectTimeout: 2000, retryStrategy: times => Math.min(times * 100, 3000),
});
deliveryRedis.on('error', () => logger.warn('Delivery Redis unavailable; push suppression/dedup will fail open'));
