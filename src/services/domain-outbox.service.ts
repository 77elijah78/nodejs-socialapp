import type { Prisma } from '@prisma/client';
import { logger } from '../config/logger.js';
import { publishReceipts } from './receipt-outbox.service.js';

export async function enqueueDomainEvent(tx: Prisma.TransactionClient, kind: string, event: object): Promise<void> {
  await tx.receiptOutbox.create({ data: { payload: JSON.parse(JSON.stringify({ kind, event })) } });
}

export async function nudgeDomainOutbox(): Promise<void> {
  await publishReceipts().catch(() => logger.warn('Domain event outbox retained for retry'));
}
