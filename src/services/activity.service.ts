import type { Notification, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { publishReceipts } from './receipt-outbox.service.js';
import { logger } from '../config/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const visible = { dismissedAt: null, withdrawnAt: null };
const postTypes = ['LIKE', 'COMMENT', 'SHARE'];
type ActivityInput = {
  userId: string; actorId: string; type: 'LIKE' | 'COMMENT' | 'FOLLOW' | 'SHARE'; content: string;
  resourceId?: string; commentId?: string; dedupeKey: string; metadata?: Prisma.InputJsonValue;
};

async function enqueueState(tx: Prisma.TransactionClient, userId: string) {
  await tx.receiptOutbox.create({ data: { payload: { kind: 'notificationState', event: {
    userId,
  } } } });
}

async function enqueue(tx: Prisma.TransactionClient, notification: Notification, kind = 'notification') {
  // Persist IDs, not private previews. Consumer rehydrates committed state before emission.
  await tx.receiptOutbox.create({ data: { payload: { kind, event: {
    id: notification.id, userId: notification.userId, version: notification.version,
    actorId: notification.actorId, type: notification.type, content: notification.content,
    ...(notification.resourceId ? { resourceId: notification.resourceId } : {}),
    ...(notification.commentId ? { commentId: notification.commentId } : {}),
    createdAt: notification.createdAt.toISOString(),
  } } } });
}

// Call inside the interaction's transaction, with its post/user row locked.
export async function createActivity(tx: Prisma.TransactionClient, data: ActivityInput) {
  if (data.userId === data.actorId) return;
  const people = await tx.user.count({ where: { id: { in: [data.userId, data.actorId] }, accountStatus: 'ACTIVE', deletedAt: null } });
  if (people !== 2) return;
  const inserted = await tx.notification.createMany({ data: [{ ...data,
    postId: postTypes.includes(data.type) ? data.resourceId : undefined,
  }], skipDuplicates: true });
  let notification = await tx.notification.findUniqueOrThrow({ where: { dedupeKey: data.dedupeKey } });
  if (!inserted.count) {
    // Undo/redo restores the same logical notification; a dismissal is permanent.
    if (!notification.withdrawnAt || notification.dismissedAt) return;
    notification = await tx.notification.update({ where: { id: notification.id }, data: {
      withdrawnAt: null, isRead: false, readAt: null, version: { increment: 1 },
    } });
  }
  await enqueue(tx, notification);
}

export async function withdrawActivity(tx: Prisma.TransactionClient, where: Prisma.NotificationWhereInput) {
  // Mutation callers serialize on their target entity. Each withdrawal is durable.
  const rows = await tx.notification.findMany({ where: { ...where, withdrawnAt: null } });
  for (const row of rows) {
    const updated = await tx.notification.update({ where: { id: row.id }, data: {
      withdrawnAt: new Date(), version: { increment: 1 },
    } });
    await enqueue(tx, updated, 'notificationUpdated');
  }
}
export async function publishActivity() {
  await publishReceipts().catch(error => logger.error('Activity outbox will retry', error));
}

// Constant query count per page; whitelist fields, including safe legacy references.
async function hydrate(items: Notification[]) {
  if (!items.length) return [];
  const postId = (n: Notification) => n.postId ?? (postTypes.includes(n.type) ? n.resourceId : null);
  const [actors, posts, comments] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: items.flatMap(i => i.actorId ? [i.actorId] : []) }, deletedAt: null, accountStatus: 'ACTIVE' },
      select: { id: true, username: true, displayName: true, avatarUrl: true } }),
    prisma.post.findMany({ where: { id: { in: items.flatMap(i => postId(i) ? [postId(i)!] : []) }, deletedAt: null },
      select: { id: true, content: true, imageUrls: true, videoUrl: true, mediaMetadata: true } }),
    prisma.comment.findMany({ where: { id: { in: items.flatMap(i => i.commentId ? [i.commentId] : []) }, deletedAt: null, post: { deletedAt: null } },
      select: { id: true, postId: true, content: true } }),
  ]);
  const actorMap = new Map(actors.map(a => [a.id, a]));
  const postMap = new Map(posts.map(p => [p.id, p]));
  const commentMap = new Map(comments.map(c => [c.id, c]));
  return items.map(i => ({ id: i.id, userId: i.userId, actorId: i.actorId, type: i.type,
    content: i.content, resourceId: i.resourceId, postId: postId(i), commentId: i.commentId,
    isRead: i.isRead, readAt: i.readAt, createdAt: i.createdAt, version: i.version,
    metadata: i.metadata, actor: i.actorId ? actorMap.get(i.actorId) ?? null : null,
    post: postMap.get(postId(i) ?? '') ?? null, comment: commentMap.get(i.commentId ?? '') ?? null,
  }));
}

const cursorSchema = z.object({ t: z.string().datetime(), id: z.string().uuid() }).strict();
function encodeCursor(row: Notification) {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), id: row.id })).toString('base64url');
}
function decodeCursor(cursor: string) {
  try {
    if (cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch { throw new ValidationError('Invalid notification cursor'); }
}

export const activityService = {
  async list(userId: string, page: number, limit: number) {
    const where = { userId, ...visible };
    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.notification.count({ where }), this.unreadCount(userId),
    ]);
    return { items: await hydrate(items), total, unreadCount };
  },
  async listCursor(userId: string, limit: number, cursor?: string) {
    const boundary = cursor ? decodeCursor(cursor) : null;
    const items = await prisma.notification.findMany({ where: { userId, ...visible,
      ...(boundary ? { OR: [{ createdAt: { lt: new Date(boundary.t) } }, { createdAt: new Date(boundary.t), id: { lt: boundary.id } }] } : {}),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const hasNext = items.length > limit;
    const page = items.slice(0, limit);
    return { items: await hydrate(page), unreadCount: await this.unreadCount(userId),
      pagination: { limit, hasNext, nextCursor: hasNext ? encodeCursor(page[page.length - 1]!) : null } };
  },
  async unreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, ...visible, isRead: false } });
  },
  async read(userId: string, ids?: string[]) {
    const result = await prisma.$transaction(async tx => {
      const changed = await tx.notification.updateMany({ where: { userId, ...visible, isRead: false,
        ...(ids ? { id: { in: ids } } : {}),
      }, data: { isRead: true, readAt: new Date() } });
      if (changed.count) await enqueueState(tx, userId);
      return changed;
    });
    await publishActivity();
    return result;
  },
  async readOne(userId: string, id: string) {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM notifications WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      const row = await tx.notification.findFirst({ where: { id, userId, ...visible } });
      if (!row) throw new NotFoundError('Notification');
      if (row.isRead) return row;
      const updated = await tx.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
      await enqueueState(tx, userId);
      return updated;
    });
    await publishActivity();
    return (await hydrate([result]))[0]!;
  },
  async dismiss(userId: string, id: string) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM notifications WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      const row = await tx.notification.findFirst({ where: { id, userId } });
      if (!row) throw new NotFoundError('Notification');
      if (!row.dismissedAt) {
        const updated = await tx.notification.update({ where: { id }, data: { dismissedAt: new Date(), version: { increment: 1 } } });
        await enqueue(tx, updated, 'notificationUpdated');
      }
    });
    await publishActivity();
    return { id, dismissed: true };
  },
  async forDelivery(userId: string, id: string) {
    const row = await prisma.notification.findFirst({ where: { id, userId, ...visible,
      user: { accountStatus: 'ACTIVE', deletedAt: null },
    } });
    return row ? (await hydrate([row]))[0] : null;
  },
};
