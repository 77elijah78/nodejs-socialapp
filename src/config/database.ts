import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from './logger.js';

// ✅ Step 1 — Define the log config as a const (preserves literal types)
const prismaLogConfig = [
  { emit: 'event', level: 'query' },
  { emit: 'event', level: 'error' },
  { emit: 'event', level: 'warn' },
] satisfies Prisma.LogDefinition[];

// ✅ Step 2 — Create a typed client type
type TypedPrismaClient = PrismaClient<{
  log: typeof prismaLogConfig;
}>;

declare global {
  // eslint-disable-next-line no-var
  var __prisma: TypedPrismaClient | undefined;
}

// ✅ Step 3 — Create the client with the typed config
const createPrismaClient = () =>
  new PrismaClient({
    log: prismaLogConfig,
  });

// ✅ Step 4 — Re-use client in dev to avoid exhausting connections
export const prisma: TypedPrismaClient =
  globalThis.__prisma ?? createPrismaClient();

// ✅ Step 5 — Register event listeners (TypeScript now knows the types)
if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;

  prisma.$on('query', (e) => {
    logger.debug(`Query: ${e.query} | Params: ${e.params} | ${e.duration}ms`);
  });
}

prisma.$on('error', (e) => {
  logger.error('Prisma error', e);
});