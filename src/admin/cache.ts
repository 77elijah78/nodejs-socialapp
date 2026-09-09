import { redisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

export async function getOrSetCache<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    logger.warn(`Admin cache read failed for ${key}`, err as Error);
  }

  const value = await factory();

  try {
    await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn(`Admin cache write failed for ${key}`, err as Error);
  }

  return value;
}

export async function invalidateCacheByPrefix(prefix: string): Promise<void> {
  try {
    const keys = await redisClient.keys(`${prefix}*`);
    if (keys.length) {
      await redisClient.del(...keys);
    }
  } catch (err) {
    logger.warn(`Admin cache invalidation failed for ${prefix}`, err as Error);
  }
}
