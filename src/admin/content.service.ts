import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { createAuditLog } from './audit.js';
import { invalidateCacheByPrefix } from './cache.js';
import { AdminContext } from './types.js';
import { buildSearchMode, clamp, parseDate, parseNumber } from './helpers.js';

function pagination(query: Record<string, unknown>) {
  const page = Math.max(1, parseNumber(query.page, 1));
  const limit = clamp(parseNumber(query.limit, 20), 1, 100);
  return { page, limit, skip: (page - 1) * limit };
}

export const adminContentService = {
  async listPosts(query: Record<string, unknown>) {
    const { page, limit, skip } = pagination(query);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const authorId = typeof query.authorId === 'string' ? query.authorId : undefined;
    const reportStatus = typeof query.reportStatus === 'string' ? query.reportStatus : undefined;
    const visibility = typeof query.visibility === 'string' ? query.visibility : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.PostWhereInput = {
      AND: [
        search
          ? {
              OR: [
                { content: { contains: search, mode: 'insensitive' as const } },
                { author: { username: { contains: search, mode: 'insensitive' as const } } },
              ],
            }
          : {},
        authorId ? { authorId } : {},
        visibility === 'deleted' ? { deletedAt: { not: null } } : visibility === 'active' ? { deletedAt: null } : {},
        reportStatus ? { reports: { some: { status: reportStatus as any } } } : {},
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: {
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } },
          _count: { select: { likes: true, comments: true, reports: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.post.count({ where }),
    ]);

    return { items, total, page, limit };
  },

  async getPost(id: string) {
    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } },
        comments: {
          where: {},
          include: {
            author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        likes: {
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        reports: {
          include: {
            reporter: { select: { id: true, username: true, displayName: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { likes: true, comments: true, reports: true } },
      },
    });
    if (!post) throw new NotFoundError('Post');
    return post;
  },

  async moderatePost(id: string, action: 'remove' | 'restore', reason: string, admin: AdminContext) {
    const post = await prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundError('Post');

    const updated = await prisma.post.update({
      where: { id },
      data: action === 'remove'
        ? { deletedAt: new Date(), deletedBy: admin.account.userId }
        : { deletedAt: null, deletedBy: null },
      include: {
        author: { select: { id: true, username: true, displayName: true } },
        _count: { select: { likes: true, comments: true, reports: true } },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: action === 'remove' ? 'POST_REMOVED' : 'POST_RESTORED',
      targetType: 'POST',
      targetId: id,
      reason,
      metadata: { authorId: post.authorId },
    });

    await invalidateCacheByPrefix('admin:dashboard');
    await invalidateCacheByPrefix('admin:analytics');
    return updated;
  },

  async listStories(query: Record<string, unknown>) {
    const { page, limit, skip } = pagination(query);
    const userId = typeof query.userId === 'string' ? query.userId : undefined;
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const state = typeof query.state === 'string' ? query.state : undefined;
    const now = new Date();

    const where: Prisma.StoryWhereInput = {
      AND: [
        userId ? { userId } : {},
        search ? { user: { username: { contains: search, mode: 'insensitive' as const } } } : {},
        state === 'active'
          ? { expiresAt: { gt: now }, deletedAt: null }
          : state === 'expired'
            ? { expiresAt: { lte: now } }
            : state === 'removed'
              ? { deletedAt: { not: null } }
              : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.story.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          _count: { select: { views: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.story.count({ where }),
    ]);

    return { items, total, page, limit };
  },

  async moderateStory(id: string, action: 'remove' | 'restore', reason: string, admin: AdminContext) {
    const story = await prisma.story.findUnique({ where: { id } });
    if (!story) throw new NotFoundError('Story');

    const updated = await prisma.story.update({
      where: { id },
      data: action === 'remove'
        ? { deletedAt: new Date(), removedBy: admin.account.userId }
        : { deletedAt: null, removedBy: null },
      include: {
        user: { select: { id: true, username: true, displayName: true } },
        _count: { select: { views: true } },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: action === 'remove' ? 'STORY_REMOVED' : 'STORY_RESTORED',
      targetType: 'STORY',
      targetId: id,
      reason,
      metadata: { userId: story.userId },
    });

    await invalidateCacheByPrefix('admin:dashboard');
    await invalidateCacheByPrefix('admin:analytics');
    return updated;
  },

  async listComments(query: Record<string, unknown>) {
    const { page, limit, skip } = pagination(query);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const postId = typeof query.postId === 'string' ? query.postId : undefined;
    const userId = typeof query.userId === 'string' ? query.userId : undefined;
    const reportStatus = typeof query.reportStatus === 'string' ? query.reportStatus : undefined;
    const state = typeof query.state === 'string' ? query.state : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.CommentWhereInput = {
      AND: [
        search ? { content: { contains: search, mode: 'insensitive' as const } } : {},
        postId ? { postId } : {},
        userId ? { authorId: userId } : {},
        state === 'removed' ? { deletedAt: { not: null } } : state === 'active' ? { deletedAt: null } : {},
        reportStatus ? { post: { reports: { some: { status: reportStatus as any } } } } : {},
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        include: {
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          post: { select: { id: true, content: true, authorId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.comment.count({ where }),
    ]);

    return { items, total, page, limit };
  },

  async moderateComment(id: string, action: 'remove' | 'restore', reason: string, admin: AdminContext) {
    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) throw new NotFoundError('Comment');

    const updated = await prisma.comment.update({
      where: { id },
      data: action === 'remove'
        ? { deletedAt: new Date(), deletedBy: admin.account.userId }
        : { deletedAt: null, deletedBy: null },
      include: {
        author: { select: { id: true, username: true, displayName: true } },
        post: { select: { id: true, content: true } },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: action === 'remove' ? 'COMMENT_REMOVED' : 'COMMENT_RESTORED',
      targetType: 'COMMENT',
      targetId: id,
      reason,
      metadata: { postId: comment.postId, authorId: comment.authorId },
    });

    await invalidateCacheByPrefix('admin:dashboard');
    await invalidateCacheByPrefix('admin:analytics');
    return updated;
  },

  async listLikes(query: Record<string, unknown>) {
    const { page, limit, skip } = pagination(query);
    const userId = typeof query.userId === 'string' ? query.userId : undefined;
    const postId = typeof query.postId === 'string' ? query.postId : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.LikeWhereInput = {
      AND: [
        userId ? { userId } : {},
        postId ? { postId } : {},
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.like.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          post: {
            select: {
              id: true,
              content: true,
              author: { select: { id: true, username: true, displayName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.like.count({ where }),
    ]);

    return { items, total, page, limit };
  },

  async listShares(query: Record<string, unknown>) {
    const { page, limit, skip } = pagination(query);
    const userId = typeof query.userId === 'string' ? query.userId : undefined;
    const postId = typeof query.postId === 'string' ? query.postId : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.MessageWhereInput = {
      AND: [
        { type: { in: ['SHARED_POST', 'SHARED_STORY'] as any } },
        userId ? { senderId: userId } : {},
        postId ? { content: postId } : {},
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {},
      ],
    };

    const [items, total] = await Promise.all([
      prisma.message.findMany({
        where,
        include: {
          sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      coverage: 'Message-based shares only. Aggregate post.shareCount may include other share flows without a discrete activity record.',
    };
  },
};
