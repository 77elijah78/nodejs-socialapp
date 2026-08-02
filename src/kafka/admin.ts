import { kafka, TOPICS } from '../config/kafka.js';
import { logger } from '../config/logger.js';

export async function ensureTopics(): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();

    const existing = await admin.listTopics();

    const toCreate = Object.values(TOPICS)
      .filter((t) => !existing.includes(t))
      .map((topic) => ({
        topic,
        numPartitions: Number(process.env.KAFKA_PARTITIONS ?? 3),
        replicationFactor: Number(process.env.KAFKA_REPLICATION ?? 1),
        configEntries: [
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) }, // 7 days
          { name: 'cleanup.policy', value: 'delete' },
        ],
      }));

    if (toCreate.length > 0) {
      await admin.createTopics({ topics: toCreate, waitForLeaders: true });
      logger.info(`✅ Created Kafka topics: ${toCreate.map((t) => t.topic).join(', ')}`);
    } else {
      logger.info('✅ Kafka topics already exist');
    }
  } finally {
    await admin.disconnect();
  }
}
