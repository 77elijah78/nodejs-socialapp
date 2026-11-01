import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { pushEnabled } from '../config/push.js';
import { AppError, ConflictError } from '../utils/errors.js';

export const pushDeviceService = {
  async register(userId: string, input: { deviceId: string; token: string; platform: 'android'; projectId: string }) {
    if (!pushEnabled()) throw new AppError('Push notifications are not enabled', 503);
    if (input.projectId !== process.env.EXPO_PROJECT_ID) throw new ConflictError('Push project does not match this application');
    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
        const conflicts = await tx.pushDevice.findMany({ where: { OR: [{ deviceId: input.deviceId }, { token: input.token }] } });
        if (conflicts.some(d => d.userId !== userId || (d.token === input.token && d.deviceId !== input.deviceId))) throw new ConflictError('Device or token is already registered');
        const existing = conflicts.find(d => d.deviceId === input.deviceId);
        if (!existing && await tx.pushDevice.count({ where: { userId } }) >= 20) throw new ConflictError('Device limit reached');
        const device = existing ? await tx.pushDevice.update({ where: { id: existing.id }, data: {
          token: input.token, enabled: true, invalidatedAt: null,
          ...(existing.token !== input.token || !existing.enabled ? { tokenVersion: { increment: 1 } } : {}),
        } }) : await tx.pushDevice.create({ data: { userId, deviceId: input.deviceId, token: input.token, platform: input.platform } });
        if (existing && device.tokenVersion !== existing.tokenVersion) await tx.pushDelivery.updateMany({
          where: { deviceId: device.id, status: 'QUEUED' }, data: { tokenVersion: device.tokenVersion },
        });
        return { deviceId: device.deviceId, platform: device.platform, enabled: device.enabled, updatedAt: device.updatedAt };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictError('Device or token is already registered');
      if (error instanceof AppError) throw error;
      throw new AppError('Device registration failed', 500);
    }
  },
  async unregister(userId: string, deviceId: string) {
    await prisma.pushDevice.deleteMany({ where: { userId, deviceId } });
    return { unregistered: true };
  },
  async preferences(userId: string) {
    return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { messagePushEnabled: true, pushPreviewsEnabled: true } });
  },
  async updatePreferences(userId: string, data: { messagePushEnabled?: boolean; pushPreviewsEnabled?: boolean }) {
    return prisma.user.update({ where: { id: userId }, data, select: { messagePushEnabled: true, pushPreviewsEnabled: true } });
  },
};

export async function enqueueMessagePush(tx: Prisma.TransactionClient, messageId: string, recipients: string[]) {
  if (!pushEnabled()) return;
  const devices = await tx.pushDevice.findMany({ where: { userId: { in: recipients }, enabled: true, token: { not: null },
    user: { accountStatus: 'ACTIVE', deletedAt: null, messagePushEnabled: true },
  }, select: { id: true, tokenVersion: true } });
  if (devices.length) await tx.pushDelivery.createMany({ data: devices.map(d => ({ messageId,
    deviceId: d.id, tokenVersion: d.tokenVersion, availableAt: new Date(Date.now() + 3000),
  })), skipDuplicates: true });
}
