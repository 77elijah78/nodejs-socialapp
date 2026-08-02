import 'dotenv/config';
import { createServer } from 'http';
import app from './app.js';
import { initSocket } from './socket/index.js';
import { logger } from './config/logger.js';
import { prisma } from './config/database.js';
import { ensureTopics } from './kafka/admin.js';
import { connectProducer, disconnectProducer } from './kafka/producer.js';
import { connectConsumer, disconnectConsumer } from './kafka/consumer.js';

const PORT = process.env.PORT ?? 3000;

async function bootstrap() {
  // 1. Database
  await prisma.$connect();
  logger.info('✅ Database connected');

  // 2. Kafka topics + producer
  await ensureTopics();
  await connectProducer();

  // 3. HTTP + WebSocket server
  const httpServer = createServer(app);
  const io = await initSocket(httpServer);
  logger.info('✅ WebSocket server initialised');

  // 4. Kafka consumer (needs io reference to emit events)
  await connectConsumer(io);

  httpServer.listen(PORT, () => {
    logger.info(`🚀 Server running on http://localhost:${PORT}`);
    logger.info(`   ENV: ${process.env.NODE_ENV}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    await disconnectConsumer();
    await disconnectProducer();
    await prisma.$disconnect();
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', err);
  process.exit(1);
});
