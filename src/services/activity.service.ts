import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { publishReceipts } from './receipt-outbox.service.js';
import { logger } from '../config/logger.js';

export async function createActivity(tx: Prisma.TransactionClient, data: {
  userId: string; actorId: string; type: 'LIKE' | 'COMMENT' | 'FOLLOW'; content: string;
  resourceId?: string; commentId?: string; dedupeKey: string;
}) {
  if (data.userId === data.actorId) return;
  const inserted = await tx.notification.createMany({ data: [{ ...data, postId: data.type !== 'FOLLOW' ? data.resourceId : undefined }], skipDuplicates: true });
  if (!inserted.count) return;
  const notification = await tx.notification.findUniqueOrThrow({ where: { dedupeKey: data.dedupeKey } });
  await tx.receiptOutbox.create({ data: { payload: { kind: 'notification', event: { ...data, id: notification.id, createdAt: notification.createdAt.toISOString() } } } });
}
export async function publishActivity() { await publishReceipts().catch(error => logger.error('Activity outbox will retry', error)); }
export const activityService = {
  async list(userId: string, page: number, limit: number) {
    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.notification.count({ where: { userId } }), prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    const [actors, posts, comments] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: items.flatMap(i => i.actorId ? [i.actorId] : []) }, deletedAt: null }, select: { id: true, username: true, displayName: true, avatarUrl: true } }),
      prisma.post.findMany({ where: { id: { in: items.flatMap(i => i.resourceId ? [i.resourceId] : []) }, deletedAt: null }, select: { id: true, content: true, imageUrls: true, videoUrl: true, mediaMetadata: true } }),
      prisma.comment.findMany({ where: { id: { in: items.flatMap(i => i.commentId ? [i.commentId] : []) }, deletedAt: null }, select: { id: true, postId: true, content: true } }),
    ]);
    return { items: items.map(i => ({ ...i, actor: actors.find(a => a.id === i.actorId) ?? null, post: posts.find(p => p.id === i.resourceId) ?? null, comment: comments.find(c => c.id === i.commentId) ?? null })), total, unreadCount };
  },
  async read(userId: string, ids?: string[]) {
    return prisma.notification.updateMany({ where: { userId, isRead: false, ...(ids ? { id: { in: ids } } : {}) }, data: { isRead: true } });
  },
};
