import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { ValidationError } from '../utils/errors.js';
import { postSelect, enrichPosts, visiblePosts } from './post.dto.js';
const WEEK = 7 * 86400000;
export function topics(content: string): string[] {
  return [...new Set((content.toLowerCase().match(/#[\p{L}\p{N}_]{1,50}/gu) ?? []).slice(0, 20))];
}
export function exploreScore(likes: number, comments: number, followers: number, ageHours: number, affinity: number) {
  const engagement = likes + 2 * comments;
  return (1 + Math.log1p(likes) + 1.5 * Math.log1p(comments) +
    2 * Math.min(1, engagement / Math.max(10, followers)) + Math.min(6, affinity)) / Math.pow(1 + Math.max(0, ageHours) / 24, 0.8);
}
// Small process-local ID-only cache; authorization/counts are never cached.
let popularCache: { expiresAt: number; ids: string[] } | undefined;
let popularPending: Promise<string[]> | undefined;
async function popularCandidateIds(tx: Prisma.TransactionClient): Promise<string[]> {
  if (popularCache && popularCache.expiresAt > Date.now()) return popularCache.ids;
  if (!popularPending) popularPending = tx.post.findMany({ where: {
    ...visiblePosts(), createdAt: { gte: new Date(Date.now() - 30 * 86400000) },
  }, select: { id: true }, orderBy: [{ likes: { _count: 'desc' } }, { id: 'desc' }], take: 500 })
    .then(rows => { const ids = rows.map(p => p.id); popularCache = { ids, expiresAt: Date.now() + 60000 }; return ids; })
    .finally(() => { popularPending = undefined; });
  return popularPending;
}

export const exploreService = {
  async get(userId: string, limit: number, cursor?: string, refresh = false) {
    if (cursor && refresh) throw new ValidationError('refresh and cursor cannot be combined');
    const page = await prisma.$transaction(async tx => {
      // Serialize refreshes/seen writes across processes, without blocking FK checks.
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR NO KEY UPDATE`;
      let position = 0;
      let session;
      if (cursor) {
        let parsed;
        try { parsed = z.object({ sessionId: z.string().uuid(), position: z.number().int().min(0).max(500) }).strict().parse(JSON.parse(Buffer.from(z.string().max(300).parse(cursor), 'base64url').toString())); }
        catch { throw new ValidationError('Invalid Explore cursor'); }
        position = parsed.position;
        session = await tx.exploreSession.findFirst({ where: { id: parsed.sessionId, userId, expiresAt: { gt: new Date() } } });
        if (!session) throw new ValidationError('Explore cursor expired or unavailable; refresh');
      } else {
        await tx.exploreSession.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
        await tx.exploreSeen.deleteMany({ where: { userId, seenAt: { lt: new Date(Date.now() - WEEK) } } });
        const old = await tx.exploreSession.findMany({ where: { userId }, orderBy: { expiresAt: 'desc' }, skip: 4, select: { id: true } });
        if (old.length) await tx.exploreSession.deleteMany({ where: { id: { in: old.map(s => s.id) } } });
        const historyWhere = { ...visiblePosts(userId) };
        const [interests, likes, saves, comments, commentLikes] = await Promise.all([
          tx.postInterest.findMany({ where: { userId, weight: { gt: 0 }, post: historyWhere }, orderBy: { updatedAt: 'desc' }, take: 80, include: { post: { select: { id: true, content: true, authorId: true } } } }),
          tx.like.findMany({ where: { userId, post: historyWhere }, orderBy: { createdAt: 'desc' }, take: 40, include: { post: { select: { id: true, content: true, authorId: true } } } }),
          tx.savedPost.findMany({ where: { userId, post: historyWhere }, orderBy: { createdAt: 'desc' }, take: 40, include: { post: { select: { id: true, content: true, authorId: true } } } }),
          tx.comment.findMany({ where: { authorId: userId, deletedAt: null, post: historyWhere }, orderBy: { createdAt: 'desc' }, take: 40, include: { post: { select: { id: true, content: true, authorId: true } } } }),
          tx.commentLike.findMany({ where: { userId, comment: { deletedAt: null, post: historyWhere } }, orderBy: { createdAt: 'desc' }, take: 40,
            include: { comment: { select: { post: { select: { id: true, content: true, authorId: true } } } } } }),
        ]);
        const history = new Map<string, { content: string; authorId: string; weight: number }>();
        for (const item of interests) history.set(item.postId, { ...item.post, weight: item.weight });
        // Canonical fallback avoids cold-start/backlog dependence on Kafka availability.
        for (const [items, weight] of [[likes, 3], [saves, 5], [comments, 2]] as const)
          for (const item of items) if (!history.has(item.post.id)) history.set(item.post.id, { ...item.post, weight });
        for (const item of commentLikes) {
          const post = item.comment.post;
          if (!history.has(post.id)) history.set(post.id, { ...post, weight: 1 });
        }
        const tagWeights = new Map<string, number>(), authorWeights = new Map<string, number>();
        for (const h of history.values()) {
          authorWeights.set(h.authorId, (authorWeights.get(h.authorId) ?? 0) + h.weight);
          for (const tag of topics(h.content)) tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + h.weight);
        }
        const where = { ...visiblePosts(), authorId: { not: userId },
          author: { deletedAt: null, accountStatus: 'ACTIVE' as const, isPrivate: false, followers: { none: { followerId: userId } } },
          seen: { none: { userId, seenAt: { gt: new Date(Date.now() - WEEK) } } },
          createdAt: { gte: new Date(Date.now() - 30 * 86400000) } };
        const select = { id: true, content: true, authorId: true, createdAt: true,
          _count: { select: { likes: true, comments: { where: { deletedAt: null } } } },
          author: { select: { _count: { select: { followers: true } } } } } as const;
        // One freshest eligible post per author gives smaller accounts a candidate slot
        // even when a prolific account floods the global recency/popularity pools.
        const discoveryIds = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM (
            SELECT DISTINCT ON (p.author_id) p.id, p.created_at
            FROM posts p JOIN users u ON u.id=p.author_id
            WHERE p.deleted_at IS NULL AND u.deleted_at IS NULL AND u.account_status='ACTIVE'
              AND NOT u.is_private AND p.author_id<>${userId}
              AND p.created_at >= ${new Date(Date.now() - 30 * 86400000)}
              AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=${userId} AND f.following_id=p.author_id)
              AND NOT EXISTS (SELECT 1 FROM explore_seen s WHERE s.user_id=${userId} AND s.post_id=p.id AND s.seen_at>${new Date(Date.now() - WEEK)})
            ORDER BY p.author_id, p.created_at DESC, p.id DESC
          ) per_author ORDER BY created_at DESC, id DESC LIMIT 100`;
        const [recent, popular, discovery] = await Promise.all([
          tx.post.findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 300 }),
          popularCandidateIds(tx).then(ids => tx.post.findMany({ where: { ...where, id: { in: ids } }, select, orderBy: [{ likes: { _count: 'desc' } }, { id: 'desc' }], take: 100 })),
          tx.post.findMany({ where: { ...where, id: { in: discoveryIds.map(p => p.id) } }, select }),
        ]);
        const candidates = [...new Map([...recent, ...popular, ...discovery].map(p => [p.id, p])).values()].map(p => ({ ...p, tags: topics(p.content),
          score: exploreScore(p._count.likes, p._count.comments, p.author._count.followers,
            (Date.now() - p.createdAt.getTime()) / 3600000,
            Math.log1p(authorWeights.get(p.authorId) ?? 0) + topics(p.content).reduce((n, t) => n + Math.log1p(tagWeights.get(t) ?? 0), 0)) }));
        const ordered: string[] = [], authorCounts = new Map<string, number>(), tagCounts = new Map<string, number>();
        while (candidates.length) {
          candidates.sort((a, b) => {
            const adjusted = (p: typeof a) => p.score / (1 + 2 * (authorCounts.get(p.authorId) ?? 0) + p.tags.reduce((n, t) => n + (tagCounts.get(t) ?? 0) * 0.4, 0));
            return adjusted(b) - adjusted(a) || b.id.localeCompare(a.id);
          });
          // At most two posts per author in a 10-item diversity window, when alternatives exist.
          const index = candidates.findIndex(p => (authorCounts.get(p.authorId) ?? 0) < 2);
          if (index < 0) break;
          const [next] = candidates.splice(index, 1); ordered.push(next!.id);
          authorCounts.set(next!.authorId, (authorCounts.get(next!.authorId) ?? 0) + 1);
          for (const tag of next!.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          if (ordered.length % 10 === 0) { authorCounts.clear(); tagCounts.clear(); }
        }
        session = await tx.exploreSession.create({ data: { userId, postIds: ordered, expiresAt: new Date(Date.now() + 15 * 60000) } });
      }
      // Re-authorize every page; consume unavailable IDs without leaking snapshot content.
      const available = await tx.post.findMany({ where: { ...visiblePosts(), id: { in: session.postIds.slice(position) },
        seen: { none: { userId, sessionId: { not: session.id }, seenAt: { gt: new Date(Date.now() - WEEK) } } },
        author: { deletedAt: null, accountStatus: 'ACTIVE', isPrivate: false, followers: { none: { followerId: userId } } } }, select: { id: true } });
      const availableIds = new Set(available.map(p => p.id));
      const ids: string[] = [];
      while (position < session.postIds.length && ids.length < limit) {
        const id = session.postIds[position++]!; if (availableIds.has(id)) ids.push(id);
      }
      const rows = await tx.post.findMany({ where: { ...visiblePosts(), id: { in: ids },
        author: { deletedAt: null, accountStatus: 'ACTIVE', isPrivate: false, followers: { none: { followerId: userId } } } }, select: postSelect });
      const byId = new Map(rows.map(p => [p.id, p]));
      const posts = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
      if (posts.length) await tx.exploreSeen.createMany({ data: posts.map(p => ({ userId, postId: p.id, sessionId: session.id })), skipDuplicates: true });
      return { posts, nextCursor: position < session.postIds.length ? Buffer.from(JSON.stringify({ sessionId: session.id, position })).toString('base64url') : undefined,
        expiresAt: session.expiresAt, exhausted: position >= session.postIds.length };
    }, { timeout: 15000 });
    return { ...page, posts: await enrichPosts(page.posts, userId) };
  },
};
