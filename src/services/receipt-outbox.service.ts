import { randomUUID } from 'node:crypto';
import { prisma } from '../config/database.js';
import { kafkaEvents, MessageReadEvent } from '../kafka/producer.js';
import { logger } from '../config/logger.js';

// Claim fencing makes overlapping immediate publishers/workers safe. A crash after
// Kafka success may repeat the same immutable receipt, intentionally at-least-once.
export async function publishReceipts(id?: string): Promise<void> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ id: string; payload: unknown; attempts: number }>>`
    UPDATE receipt_outbox SET claim_token=${token},
      lease_until=clock_timestamp() + interval '60 seconds', attempts=attempts+1
    WHERE id IN (SELECT id FROM receipt_outbox
      WHERE available_at <= clock_timestamp()
      AND (lease_until IS NULL OR lease_until < clock_timestamp())
      AND (${id ?? null}::text IS NULL OR id=${id ?? null})
      ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED)
    RETURNING id, payload, attempts`;
  for (const row of rows) {
    try {
      const payload = row.payload as { kind?: string; event?: object };
      if (payload.kind) {
        const publishers = kafkaEvents as unknown as Record<string, (event: object) => Promise<void>>;
        if (!['chatMessage', 'messageDelivered', 'messageDeleted', 'messageDeletedForMe'].includes(payload.kind)) throw new Error('Unknown outbox event');
        await publishers[payload.kind](payload.event!);
      } else await kafkaEvents.messageRead(row.payload as MessageReadEvent);
      await prisma.receiptOutbox.deleteMany({ where: { id: row.id, claimToken: token } });
    } catch (error) {
      logger.error('Receipt publication retained for retry', error);
      await prisma.receiptOutbox.updateMany({
        where: { id: row.id, claimToken: token },
        data: { claimToken: null, leaseUntil: null,
          availableAt: new Date(Date.now() + Math.min(60_000, 500 * 2 ** Math.min(row.attempts, 7))) },
      });
    }
  }
}

export function startReceiptPublisher() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let active: Promise<void> = Promise.resolve();
  const run = () => {
    active = publishReceipts().catch(error => logger.error('Receipt worker failed', error))
      .then(() => { if (!stopped) timer = setTimeout(run, 1000); });
  };
  run();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
