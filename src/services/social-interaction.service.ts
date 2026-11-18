import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/database.js';
export const socialEventSchema = z.object({ version: z.literal(1), eventId: z.string().uuid(),
  type: z.enum(['post.created','post.liked','post.unliked','comment.created','comment.deleted','comment.liked','comment.unliked','post.bookmarked','post.unbookmarked']),
  actorId: z.string().uuid(), postId: z.string().uuid(), commentId: z.string().uuid().optional() });
export type SocialEvent = z.infer<typeof socialEventSchema>;
export async function enqueueSocial(tx: Prisma.TransactionClient, type: SocialEvent['type'], actorId: string, postId: string, commentId?: string) {
  const event: SocialEvent = { version: 1, eventId: randomUUID(), type, actorId, postId, ...(commentId ? { commentId } : {}) };
  await tx.receiptOutbox.create({ data: { payload: { kind: 'socialInteraction', event } } });
}
// Replays and out-of-order events converge to DB truth; no event delta counters.
export async function processSocialInteraction(payload: unknown) {
  const event = socialEventSchema.parse(payload);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM posts WHERE id=${event.postId} FOR UPDATE`;
    const post = await tx.post.findUnique({ where: { id: event.postId }, select: { deletedAt: true } });
    if (!post || post.deletedAt || !await tx.user.findUnique({ where: { id: event.actorId }, select: { id: true } })) return;
    const [likes, saves, comments, commentLikes] = await Promise.all([
      tx.like.count({ where: { userId: event.actorId, postId: event.postId } }),
      tx.savedPost.count({ where: { userId: event.actorId, postId: event.postId } }),
      tx.comment.count({ where: { authorId: event.actorId, postId: event.postId, deletedAt: null } }),
      tx.commentLike.count({ where: { userId: event.actorId, comment: { postId: event.postId, deletedAt: null } } }),
    ]);
    const weight = 3 * likes + 5 * saves + 2 * Math.min(5, comments) + Math.min(3, commentLikes);
    const key = { userId: event.actorId, postId: event.postId };
    if (!weight) { await tx.postInterest.deleteMany({ where: key }); return; }
    const existing = await tx.postInterest.findUnique({ where: { userId_postId: key }, select: { weight: true } });
    if (existing?.weight === weight) return; // Duplicate signals must not move history recency either.
    await tx.postInterest.upsert({ where: { userId_postId: key },
      create: { ...key, weight }, update: { weight } });
  });
}
