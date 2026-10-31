import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { isSharedMediaUrl } from '../config/media.js';
import { createActivity, publishActivity } from './activity.service.js';
import { prisma } from '../config/database.js';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/errors.js';
import { kafkaEvents } from '../kafka/producer.js';
import { messageService } from './message.service.js';

const postSelect = {
  id: true,
  content: true,
  imageUrls: true, mediaMetadata: true,
  videoUrl: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } },
  _count: { select: { likes: true, comments: { where: { deletedAt: null } } } },
  shareCount: true,
};

const commentSelect = {
  id: true, postId: true, authorId: true,
  content: true,
  createdAt: true,
  repliedToId: true,
  author: { select: { id: true, username: true, avatarUrl: true } },
};

export const postService = {
  async createPost(authorId: string, data: { content: string; imageUrls?: string[]; videoUrl?: string | null; mediaMetadata?: Prisma.InputJsonValue }) {
    for (const url of [...(data.imageUrls ?? []), ...(data.videoUrl ? [data.videoUrl] : [])]) if (!isSharedMediaUrl(url)) throw new ValidationError('Invalid shared media URL');
    if (!data.content?.trim() && !data.imageUrls?.length && !data.videoUrl) throw new ValidationError('Post content or media is required');
    if (!data.mediaMetadata) {
      const assets = await prisma.mediaAsset.findMany({ where: { url: { in: [...(data.imageUrls ?? []), ...(data.videoUrl ? [data.videoUrl] : [])] } } });
      if (assets.length) data = { ...data, mediaMetadata: assets.map(a => ({ url: a.url, mimeType: a.mimeType, size: a.size })) };
    }
    return prisma.post.create({
      data: { ...data, content: data.content ?? '', imageUrls: data.imageUrls ?? [], authorId },
      select: postSelect,
    });
  },

  async getFeed(userId: string, page: number, limit: number) {
    const following = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    });

    const authorIds = [userId, ...following.map((f) => f.followingId)];

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where: { authorId: { in: authorIds }, deletedAt: null },
        select: postSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.post.count({ where: { authorId: { in: authorIds }, deletedAt: null } }),
    ]);

    // Map to include isLiked and isSaved flags
    const likedPostIds = await prisma.like.findMany({
      where: { userId, postId: { in: posts.map((p) => p.id) } },
      select: { postId: true },
    });

    const savedPostIds = await prisma.savedPost.findMany({
      where: { userId, postId: { in: posts.map((p) => p.id) } },
      select: { postId: true },
    });

    const likedSet = new Set(likedPostIds.map((l) => l.postId));
    const savedSet = new Set(savedPostIds.map((s) => s.postId));

    const enriched = posts.map((p) => ({
      ...p,
      isLiked: likedSet.has(p.id),
      isSaved: savedSet.has(p.id),
    }));

    return { posts: enriched, total };
  },

  async getPost(postId: string) {
    const post = await prisma.post.findUnique({
      where: { id: postId, deletedAt: null },
      select: {
        ...postSelect,
        comments: {
          where: { deletedAt: null },
          select: {
            ...commentSelect,
          },
          orderBy: { createdAt: 'asc' },
          take: 20,
        },
      },
    });
    if (!post) throw new NotFoundError('Post');
    return post;
  },

  async updatePost(postId: string, userId: string, data: { content?: string; imageUrls?: string[]; videoUrl?: string | null; mediaMetadata?: Prisma.InputJsonValue }) {
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundError('Post');
    if (post.authorId !== userId) throw new ForbiddenError();

    return prisma.post.update({
      where: { id: postId },
      data,
      select: postSelect,
    });
  },

  async deletePost(postId: string, userId: string) {
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundError('Post');
    if (post.authorId !== userId) throw new ForbiddenError();

    // Soft delete
    await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
    return { message: 'Post deleted' };
  },

  async likePost(postId: string, userId: string) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      const post = await tx.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorId: true } });
      if (!post) throw new NotFoundError('Post');
      await tx.like.upsert({ where: { userId_postId: { userId, postId } }, create: { userId, postId }, update: {} });
      await createActivity(tx, { type: 'LIKE', userId: post.authorId, actorId: userId,
        content: 'liked your post', resourceId: postId, dedupeKey: `like:${postId}:${userId}` });
    });
    await publishActivity();
    return { message: 'Post liked' };
  },

  async unlikePost(postId: string, userId: string) {
    await prisma.like.deleteMany({ where: { userId, postId } });
    return { message: 'Post unliked' };
  },

  async addComment(postId: string, authorId: string, content: string, repliedToId?: string | null, clientRequestId?: string) {
    content = z.string().trim().min(1).max(500).parse(content);
    if (clientRequestId) z.string().uuid().parse(clientRequestId);
    const comment = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      const post = await tx.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorId: true } });
      if (!post) throw new NotFoundError('Post');
      if (clientRequestId) {
        const existing = await tx.comment.findUnique({ where: { authorId_clientRequestId: { authorId, clientRequestId } }, select: { ...commentSelect, deletedAt: true } });
        if (existing) {
          if (existing.postId !== postId || existing.content !== content || existing.repliedToId !== (repliedToId ?? null) || existing.deletedAt) throw new ConflictError('Comment retry key reused with different or deleted content');
          const { deletedAt: _deletedAt, ...result } = existing;
          return result;
        }
      }
      const parent = repliedToId ? await tx.comment.findFirst({ where: { id: repliedToId, postId, deletedAt: null }, select: { authorId: true } }) : null;
      if (repliedToId && !parent) throw new ValidationError('Invalid comment reply target');
      const created = await tx.comment.create({ data: { content, authorId, postId, repliedToId: repliedToId ?? null, clientRequestId }, select: commentSelect });
      for (const recipient of new Set([post.authorId, ...(parent ? [parent.authorId] : [])])) {
        await createActivity(tx, { type: 'COMMENT', userId: recipient, actorId: authorId,
          content: parent?.authorId === recipient ? 'replied to your comment' : 'commented on your post',
          resourceId: postId, commentId: created.id, dedupeKey: `comment:${created.id}:${recipient}` });
      }
      return created;
    });
    await publishActivity();
    return comment;
  },

  async getComments(postId: string, requesterId: string, page: number, limit: number) {
    if (!await prisma.post.findFirst({ where: { id: postId, deletedAt: null }, select: { id: true } })) throw new NotFoundError('Post');
    const where = { postId, deletedAt: null };
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({ where, select: commentSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
      prisma.comment.count({ where }),
    ]);
    return { comments: comments.map(c => ({ ...c, isMine: c.authorId === requesterId })), total };
  },

  async deleteComment(postId: string, commentId: string, userId: string) {
    return prisma.$transaction(async tx => {
      const comment = await tx.comment.findFirst({ where: { id: commentId, postId, post: { deletedAt: null } }, select: { authorId: true, post: { select: { authorId: true } } } });
      if (!comment) throw new NotFoundError('Comment');
      if (comment.authorId !== userId && comment.post.authorId !== userId) throw new ForbiddenError('Cannot delete this comment');
      await tx.comment.updateMany({ where: { id: commentId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: userId } });
      return { commentId };
    });
  },

  async savePost(postId: string, userId: string) {
    const post = await prisma.post.findUnique({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundError('Post');

    const existing = await prisma.savedPost.findUnique({
      where: { userId_postId: { userId, postId } },
    });
    if (existing) throw new ConflictError('Post already saved');

    await prisma.savedPost.create({ data: { userId, postId } });
    return { message: 'Post saved' };
  },

  async unsavePost(postId: string, userId: string) {
    const post = await prisma.post.findUnique({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundError('Post');

    await prisma.savedPost.deleteMany({ where: { userId, postId } });
    return { message: 'Post unsaved' };
  },

  async getSavedPosts(userId: string, page: number, limit: number) {
    const [saved, total] = await Promise.all([
      prisma.savedPost.findMany({
        where: { userId, post: { deletedAt: null } },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          post: {
            select: {
              ...postSelect,
            },
          },
        },
      }),
      prisma.savedPost.count({ where: { userId, post: { deletedAt: null } } }),
    ]);

    return { posts: saved.map((s) => s.post), total };
  },

  async getLikedPosts(userId: string, page: number, limit: number) {
    const [liked, total] = await Promise.all([
      prisma.like.findMany({
        where: { userId, post: { deletedAt: null } },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          post: {
            select: {
              ...postSelect,
            },
          },
        },
      }),
      prisma.like.count({ where: { userId, post: { deletedAt: null } } }),
    ]);

    return { posts: liked.map((l) => l.post), total };
  },

  async getStories(userId: string) {
    const following = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    });

    const userIds = [userId, ...following.map((f) => f.followingId)];

    const stories = await prisma.story.findMany({
      where: {
        userId: { in: userIds },
        expiresAt: { gt: new Date() },
        deletedAt: null,
      },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        views: { where: { viewerId: userId } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return stories;
  },

  async getUserPosts(username: string, requesterId: string | undefined, page: number, limit: number) {
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, isVerified: true },
    });
    if (!user) throw new NotFoundError('User');

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where: { authorId: user.id, deletedAt: null },
        select: postSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.post.count({ where: { authorId: user.id, deletedAt: null } }),
    ]);

    const likedPostIds = requesterId
      ? await prisma.like.findMany({
          where: { userId: requesterId, postId: { in: posts.map((p) => p.id) } },
          select: { postId: true },
        })
      : [];

    const likedSet = new Set(likedPostIds.map((l) => l.postId));

    const enriched = posts.map((p) => ({
      ...p,
      isLiked: likedSet.has(p.id),
      isSaved: false,
    }));

    return {
      user: {
        ...user,
        _count: { posts: total },
      },
      posts: enriched,
      total,
    };
  },

  async createStory(userId: string, data: { mediaUrl: string; mediaType: string; caption?: string }) {
    const story = await prisma.story.create({
      data: {
        userId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        caption: data.caption ?? null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return story;
  },

  async markStoryViewed(viewerId: string, storyId: string) {
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      select: { userId: true, deletedAt: true },
    });
    if (!story || story.deletedAt) {
       throw new NotFoundError("Story");
    }
    await prisma.storyView.upsert({
      where: {
        storyId_viewerId: {
          storyId,
          viewerId,
        },
      },
      create: {
        storyId,
        viewerId,
      },
      update: {},
    });
  },

  async sharePost(postId: string, userId: string, conversationId: string) {
    const post = await prisma.post.findUnique({
      where: { id: postId, deletedAt: null },
      select: { id: true, authorId: true, shareCount: true, content: true, imageUrls: true, videoUrl: true },
    });
    if (!post) throw new NotFoundError('Post');

    if (post.authorId === userId) {
      throw new ForbiddenError('Cannot share your own post');
    }

    await prisma.post.update({
      where: { id: postId },
      data: { shareCount: { increment: 1 } },
    });

    await prisma.notification.create({
      data: {
        type: 'SHARE',
        content: 'shared your post',
        userId: post.authorId,
        actorId: userId,
        resourceId: postId,
      },
    });

    await kafkaEvents.notification({
      userId: post.authorId,
      actorId: userId,
      type: 'SHARE',
      content: 'shared your post',
      resourceId: postId,
    });

    return { postId, shareCount: post.shareCount + 1 };
  },

  async shareStory(storyId: string, userId: string, conversationId: string) {
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      select: { id: true, userId: true, expiresAt: true, deletedAt: true },
    });
    if (!story || story.deletedAt) throw new NotFoundError('Story');

    if (story.userId === userId) {
      throw new ForbiddenError('Cannot share your own story');
    }

    if (story.expiresAt < new Date()) {
      throw new ForbiddenError('Story has expired');
    }

    return { storyId };
  },

  async reportPost(postId: string, reporterId: string, reason: string, details?: string | null) {
    const post = await prisma.post.findUnique({
      where: { id: postId, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!post) throw new NotFoundError('Post');

    if (post.authorId === reporterId) {
      throw new ForbiddenError('Cannot report your own post');
    }

    const existing = await prisma.report.findFirst({
      where: { postId, reporterId },
    });
    if (existing) {
      throw new ConflictError('You have already reported this post');
    }

    const report = await prisma.report.create({
      data: {
        postId,
        reporterId,
        reason,
        details: details ?? null,
      },
      select: {
        id: true,
        postId: true,
        reason: true,
        details: true,
        status: true,
        createdAt: true,
      },
    });

    return report;
  },

  async sharePostToUser(postId: string, senderId: string, targetUsername: string) {
    const post = await prisma.post.findUnique({
      where: { id: postId, deletedAt: null },
      select: { id: true, authorId: true, shareCount: true, content: true, imageUrls: true, videoUrl: true },
    });
    if (!post) throw new NotFoundError('Post');

    const targetUser = await prisma.user.findUnique({
      where: { username: targetUsername },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundError('Target user not found');

    if (targetUser.id === senderId) {
      throw new ForbiddenError('Cannot share to yourself');
    }

    const conversation = await messageService.getOrCreateConversation(senderId, targetUser.id);

    await prisma.post.update({
      where: { id: postId },
      data: { shareCount: { increment: 1 } },
    });

    await messageService.sendMessage(conversation.id, senderId, post.id, targetUser.id, {
      type: 'SHARED_POST', sharedReference: { id: post.id, kind: 'post',
        preview: { content: post.content, imageUrls: post.imageUrls, videoUrl: post.videoUrl } },
    });

    if (post.authorId !== senderId) {
      await prisma.notification.create({
        data: {
          type: 'SHARE',
          content: 'shared your post',
          userId: post.authorId,
          actorId: senderId,
          resourceId: postId,
        },
      });
    }

    return { postId, shareCount: post.shareCount + 1, conversationId: conversation.id };
  },
};
