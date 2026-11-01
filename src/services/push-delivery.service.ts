import { randomUUID } from 'node:crypto';
import type { Prisma, PushDeliveryStatus } from '@prisma/client';
import { prisma } from '../config/database.js';
import { pushEnabled } from '../config/push.js';
import { logger } from '../config/logger.js';
import { isDeviceViewing } from './delivery-state.service.js';
import { sendExpoPush, getExpoReceipt, PushProviderError, type ExpoPushPayload } from './expo-push.provider.js';

const DAY = 86400000;
const RETRY_LIMIT = 5;
const receiptDelay = 15 * 60000;
const backoff = (attempts: number) => new Date(Date.now() + Math.min(900000, 5000 * 2 ** Math.min(attempts, 8)) + Math.floor(Math.random() * 1000));

async function processDelivery(id: string, claimToken: string) {
  const job = await prisma.pushDelivery.findFirst({ where: { id, claimToken }, include: {
    device: { include: { user: { select: { accountStatus: true, deletedAt: true, messagePushEnabled: true, pushPreviewsEnabled: true } } } },
    message: { include: { sender: { select: { displayName: true, username: true } }, conversation: { select: { isGroup: true, groupName: true } } } },
  } });
  if (!job) return;
  const finish = (data: Prisma.PushDeliveryUpdateManyMutationInput) => prisma.pushDelivery.updateMany({
    where: { id, claimToken }, data: { ...data, claimToken: null, leaseUntil: null },
  });
  const invalidToken = async () => {
    // Fences late errors for an old token: never invalidate a refreshed token.
    await prisma.pushDevice.updateMany({ where: { id: job.deviceId, tokenVersion: job.tokenVersion },
      data: { enabled: false, token: null, invalidatedAt: new Date() } });
  };
  if (job.status === 'RECEIPT_PENDING') {
    try {
      const receipt = await getExpoReceipt(job.ticketId!);
      if (!receipt) {
        await finish(Date.now() - job.createdAt.getTime() > DAY
          ? { status: 'UNKNOWN', errorCode: 'ReceiptExpired' }
          : { availableAt: new Date(Date.now() + receiptDelay) });
      } else if (receipt.status === 'ok') await finish({ status: 'RECEIPT_OK', errorCode: null });
      else {
        const code = receipt.details?.error ?? 'ReceiptRejected';
        if (code === 'DeviceNotRegistered') await invalidToken();
        await finish({ status: code === 'MessageRateExceeded' && job.attempts < RETRY_LIMIT ? 'QUEUED' : 'FAILED',
          errorCode: code, ticketId: null, availableAt: backoff(job.attempts) });
      }
    } catch {
      // Polling is safe to retry: do not resend an already-ticketed notification.
      await finish(Date.now() - job.createdAt.getTime() > DAY
        ? { status: 'UNKNOWN', errorCode: 'ReceiptExpired' }
        : { availableAt: new Date(Date.now() + receiptDelay), errorCode: 'ReceiptLookupFailed' });
    }
    return;
  }
  const { device, message } = job;
  const user = device.user;
  if (!device.enabled || !device.token || device.tokenVersion !== job.tokenVersion || user.deletedAt || user.accountStatus !== 'ACTIVE' ||
      !user.messagePushEnabled || message.senderId === device.userId || message.deletedAt || Date.now() - job.createdAt.getTime() > DAY) {
    await finish({ status: 'CANCELLED', errorCode: 'NoLongerEligible' }); return;
  }
  const [member, receipt, hidden] = await Promise.all([
    prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId: message.conversationId, userId: device.userId } }, select: { deletedAt: true } }),
    prisma.messageReceipt.findUnique({ where: { messageId_userId: { messageId: message.id, userId: device.userId } }, select: { readAt: true } }),
    prisma.messageDeletion.findUnique({ where: { messageId_userId: { messageId: message.id, userId: device.userId } }, select: { userId: true } }),
  ]);
  if (!member || member.deletedAt || !receipt || receipt.readAt || hidden || await isDeviceViewing(device.id, message.conversationId)) {
    await finish({ status: 'CANCELLED', errorCode: 'ReadHiddenOrViewing' }); return;
  }
  const previews: Record<string, string> = { IMAGE: 'Sent a photo', VIDEO: 'Sent a video', AUDIO: 'Sent a voice message',
    DOCUMENT: 'Sent a document', SHARED_POST: 'Shared a post', SHARED_STORY: 'Shared a story' };
  const senderName = message.sender.displayName || message.sender.username;
  const payload: ExpoPushPayload = {
    to: device.token, title: user.pushPreviewsEnabled
      ? (message.conversation.isGroup ? `${senderName} · ${message.conversation.groupName || 'Group conversation'}` : senderName).slice(0, 128)
      : 'New message',
    body: user.pushPreviewsEnabled ? (previews[message.type] ?? (message.content.slice(0, 160) || 'Sent a message')) : 'You have a new message',
    sound: 'default', channelId: 'messages', priority: 'high', ttl: 3600,
    data: { messageId: message.id, conversationId: message.conversationId, senderId: message.senderId,
      conversationType: message.conversation.isGroup ? 'group' : 'private', notificationType: 'MESSAGE', notificationId: job.id },
  };
  try {
    const ticketId = await sendExpoPush(payload);
    await finish({ status: 'RECEIPT_PENDING', ticketId, errorCode: null, availableAt: new Date(Date.now() + receiptDelay) });
  } catch (error) {
    const provider = error instanceof PushProviderError ? error : new PushProviderError('UnexpectedSendFailure', false, true);
    if (provider.code === 'DeviceNotRegistered') await invalidToken();
    const status: PushDeliveryStatus = provider.ambiguous ? 'UNKNOWN' : provider.retryable && job.attempts < RETRY_LIMIT ? 'QUEUED' : 'FAILED';
    await finish({ status, errorCode: provider.code, availableAt: backoff(job.attempts) });
    logger.warn(JSON.stringify({ event: 'push.provider_result', jobId: id, messageId: message.id, status, errorCode: provider.code }));
  }
}

export async function processPushDeliveries(): Promise<void> {
  if (!pushEnabled()) return;
  // A crash after network dispatch has an uncertain outcome. Never blindly resend.
  await prisma.pushDelivery.updateMany({ where: { status: 'SENDING', leaseUntil: { lt: new Date() } },
    data: { status: 'UNKNOWN', errorCode: 'SendLeaseExpired', claimToken: null, leaseUntil: null } });
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE push_deliveries SET claim_token=${token}, lease_until=clock_timestamp()+interval '120 seconds',
      attempts=attempts+CASE WHEN status='QUEUED' THEN 1 ELSE 0 END,
      receipt_attempts=receipt_attempts+CASE WHEN status='RECEIPT_PENDING' THEN 1 ELSE 0 END,
      status=CASE WHEN status='QUEUED' THEN 'SENDING'::"PushDeliveryStatus" ELSE status END,
      updated_at=clock_timestamp()
    WHERE id IN (SELECT id FROM push_deliveries WHERE status IN ('QUEUED','RECEIPT_PENDING')
      AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
      ORDER BY available_at LIMIT 10 FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  await Promise.all(rows.map(row => processDelivery(row.id, token).catch(async () => {
    // Keep claims fenced. Expired SENDING becomes UNKNOWN; receipt lookups can retry.
    logger.error(JSON.stringify({ event: 'push.worker_failed', jobId: row.id }));
  })));
}

export function startPushPublisher() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let active: Promise<void> = Promise.resolve();
  const run = () => {
    active = processPushDeliveries().catch(() => logger.error('Push worker iteration failed'))
      .then(() => { if (!stopped) timer = setTimeout(run, 1000); });
  };
  run();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
