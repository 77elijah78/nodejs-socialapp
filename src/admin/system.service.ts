import fs from 'fs/promises';
import path from 'path';
import { kafka } from '../config/kafka.js';
import { prisma } from '../config/database.js';
import { redisClient } from '../config/redis.js';

async function timedCheck<T>(name: string, fn: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return {
      name,
      healthy: true,
      durationMs: Date.now() - startedAt,
      details: result,
    };
  } catch (error) {
    return {
      name,
      healthy: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function readRecentErrors() {
  const logsDir = path.resolve('logs');
  try {
    const files = await fs.readdir(logsDir);
    const errorFiles = files.filter((file) => file.startsWith('error-')).sort().reverse();
    const latest = errorFiles[0];
    if (!latest) return [];

    const content = await fs.readFile(path.join(logsDir, latest), 'utf8');
    return content
      .trim()
      .split('\n')
      .slice(-20)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const adminSystemService = {
  async getOverview() {
    const uploadsPath = path.resolve(process.env.UPLOADS_PATH ?? 'uploads');

    const [database, redis, kafkaCheck, mediaStorage, recentErrors] = await Promise.all([
      timedCheck('database', async () => prisma.$queryRawUnsafe('SELECT 1')), 
      timedCheck('redis', async () => redisClient.ping()),
      timedCheck('kafka', async () => {
        const admin = kafka.admin();
        await admin.connect();
        const topics = await admin.listTopics();
        await admin.disconnect();
        return { topics: topics.length };
      }),
      timedCheck('mediaStorage', async () => {
        await fs.mkdir(uploadsPath, { recursive: true });
        const stats = await fs.stat(uploadsPath);
        return { path: uploadsPath, writable: stats.isDirectory() };
      }),
      readRecentErrors(),
    ]);

    const services = [database, redis, kafkaCheck, mediaStorage];

    return {
      healthy: services.every((service) => service.healthy),
      services,
      backgroundJobs: [
        {
          name: 'kafka-consumer',
          healthy: kafkaCheck.healthy,
          details: kafkaCheck.healthy ? 'Kafka event pipeline reachable' : kafkaCheck.error,
        },
      ],
      recentErrors,
    };
  },
};
