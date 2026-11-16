import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { isSharedMediaUrl } from '../config/media.js';
import { createActivity, publishActivity, withdrawActivity } from './activity.service.js';
import { prisma } from '../config/database.js';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/errors.js';
import { messageService } from './message.service.js';

import { postSelect, commentSelect, enrichPosts, enrichComments, visiblePosts } from './post.dto.js';
import { enqueueSocial } from './social-interaction.service.js';
import { decodeFeedCursor, encodeFeedCursor } from '../utils/feed-cursor.js';

export const postService = {
  async createPost(authorId: string, data: { content: string; imageUrls?: string[]; videoUrl?: string | null; mediaMetadata?: Prisma.InputJsonValue }) {
    for (const url of [...(data.imageUrls ?? []), ...(data.videoUrl ? [data.videoUrl] : [])]) if (!isSharedMediaUrl(url)) throw new ValidationError('Invalid shared media URL');
    if (!data.content?.trim() && !data.imageUrls?.length && !data.videoUrl) throw new ValidationError('Post content or media is required');
    if (!data.mediaMetadata) {
      const assets = await prisma.mediaAsset.findMany({ where: { url: { in: [...(data.imageUrls ?? []), ...(data.videoUrl ? [data.videoUrl] : [])] } } });
      if (assets.length) data = { ...data, mediaMetadata: assets.map(a => ({ url: a.url, mimeType: a.mimeType, size: a.size })) };
    }
    const post = await prisma.$transaction(async tx => {
      const created = await tx.post.create({ data: { ...data, content: data.content ?? '', imageUrls: data.imageUrls ?? [], authorId }, select: postSelect });
      await enqueueSocial(tx, 'post.created', authorId, created.id);
      return created;
    });
    await publishActivity();
    return (await enrichPosts([post], authorId))[0]!;
  },

  async getFeed(userId: string, page: number, limit: number) {
    const where: Prisma.PostWhereInput = { ...visiblePosts(userId), OR: [
      { authorId: userId }, { author: { followers: { some: { followerId: userId } } } },
    ] };

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        select: postSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.post.count({ where }),
    ]);

    return { posts: await enrichPosts(posts, userId), total };
  },

  async getPostEngagement(postId: string, userId: string) {
    const post = await prisma.post.findFirst({ where: { ...visiblePosts(userId), id: postId },
      select: { id: true, _count: { select: { likes: true, comments: { where: { deletedAt: null } } } } } });
    if (!post) throw new NotFoundError('Post');
    const [like, bookmark] = await Promise.all([
      prisma.like.findUnique({ where: { userId_postId: { userId, postId } }, select: { postId: true } }),
      prisma.savedPost.findUnique({ where: { userId_postId: { userId, postId } }, select: { postId: true } }),
    ]);
    return { postId, likesCount: post._count.likes, commentsCount: post._count.comments,
      isLikedByCurrentUser: !!like, isBookmarkedByCurrentUser: !!bookmark };
  },

  async getPost(postId: string, userId?: string) {
    const post = await prisma.post.findUnique({
      where: { ...visiblePosts(userId), id: postId },
      select: {
        ...postSelect,
        comments: {
          where: { deletedAt: null },
          select: {
            ...commentSelect,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 20,
        },
      },
    });
    if (!post) throw new NotFoundError('Post');
    return { ...(await enrichPosts([post], userId))[0]!, comments: await enrichComments(post.comments, userId) };
  },

  async updatePost(postId: string, userId: string, data: { content?: string; imageUrls?: string[]; videoUrl?: string | null; mediaMetadata?: Prisma.InputJsonValue }) {
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundError('Post');
    if (post.authorId !== userId) throw new ForbiddenError();

    const updated = await prisma.post.update({ where: { id: postId }, data, select: postSelect });
    return (await enrichPosts([updated], userId))[0]!;
  },

  async deletePost(postId: string, userId: string) {
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundError('Post');
    if (post.authorId !== userId) throw new ForbiddenError();

    // Soft delete
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      await tx.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
      await withdrawActivity(tx, { OR: [{ postId }, { resourceId: postId, type: { in: ['LIKE', 'COMMENT', 'SHARE'] } }] });
    });
    await publishActivity();
    return { message: 'Post deleted' };
  },

  async likePost(postId: string, userId: string) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      const post = await tx.post.findFirst({ where: { ...visiblePosts(userId), id: postId }, select: { authorId: true } });
      if (!post) throw new NotFoundError('Post');
      const existed = await tx.like.findUnique({ where: { userId_postId: { userId, postId } } });
      await tx.like.upsert({ where: { userId_postId: { userId, postId } }, create: { userId, postId }, update: {} });
      await createActivity(tx, { type: 'LIKE', userId: post.authorId, actorId: userId,
        content: 'liked your post', resourceId: postId, dedupeKey: `like:${postId}:${userId}` });
      if (!existed) await enqueueSocial(tx, 'post.liked', userId, postId);
    });
    await publishActivity();
    return { message: 'Post liked', ...(await this.getPost(postId, userId)) };
  },

  async unlikePost(postId: string, userId: string) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      if (!await tx.post.findFirst({ where: { ...visiblePosts(userId), id: postId }, select: { id: true } })) throw new NotFoundError('Post');
      const removed = await tx.like.deleteMany({ where: { userId, postId } });
      if (removed.count) await enqueueSocial(tx, 'post.unliked', userId, postId);
      await withdrawActivity(tx, { actorId: userId, type: 'LIKE', OR: [{ postId }, { resourceId: postId }] });
    });
    await publishActivity();
    return { message: 'Post unliked', ...(await this.getPost(postId, userId)) };
  },

  async addComment(postId: string, authorId: string, content: string, repliedToId?: string | null, clientRequestId?: string) {
    content = z.string().trim().min(1).max(500).parse(content);
    if (clientRequestId) z.string().uuid().parse(clientRequestId);
    const comment = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      const post = await tx.post.findFirst({ where: { ...visiblePosts(authorId), id: postId }, select: { authorId: true } });
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
          metadata: { interaction: parent?.authorId === recipient ? 'COMMENT_REPLY' : 'POST_COMMENT', ...(parent ? { repliedToId: repliedToId! } : {}) },
          resourceId: postId, commentId: created.id, dedupeKey: `comment:${created.id}:${recipient}` });
      }
      await enqueueSocial(tx, 'comment.created', authorId, postId, created.id);
      return created;
    });
    await publishActivity();
    return (await enrichComments([comment], authorId))[0]!;
  },

  async getComments(postId: string, requesterId: string, page: number, limit: number, cursor?: string) {
    if (!await prisma.post.findFirst({ where: { ...visiblePosts(requesterId), id: postId }, select: { id: true } })) throw new NotFoundError('Post');
    const after = decodeFeedCursor(cursor);
    const where = { postId, deletedAt: null };
    const [rows, total] = await Promise.all([
      prisma.comment.findMany({ where: { ...where, ...(after ? { OR: [{ createdAt: { gt: new Date(after.at) } }, { createdAt: new Date(after.at), id: { gt: after.id } }] } : {}) },
        select: commentSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: after ? 0 : (page - 1) * limit, take: limit + 1 }),
      prisma.comment.count({ where }),
    ]);
    const more = rows.length > limit, comments = rows.slice(0, limit), last = comments.at(-1);
    return { comments: (await enrichComments(comments, requesterId)).map(c => ({ ...c, isMine: c.authorId === requesterId })), total,
      nextCursor: more && last ? encodeFeedCursor(last.createdAt, last.id) : undefined };
  },

  async commentEngagement(postId: string, commentId: string, userId: string) {
    const comment = await prisma.comment.findFirst({ where: { id: commentId, postId, deletedAt: null, post: visiblePosts(userId) }, select: commentSelect });
    if (!comment) throw new NotFoundError('Comment');
    return (await enrichComments([comment], userId))[0]!;
  },

  async setCommentLike(postId: string, commentId: string, userId: string, liked: boolean) {
    const result = await prisma.$transaction(async tx => {
      // Same lock order as deletion/comment creation; PK/unique is the final duplicate guard.
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM comments WHERE id=${commentId} AND post_id=${postId} FOR UPDATE`;
      const comment = await tx.comment.findFirst({ where: { id: commentId, postId, deletedAt: null, post: visiblePosts(userId) }, select: { id: true } });
      if (!comment) throw new NotFoundError('Comment');
      const existing = await tx.commentLike.findUnique({ where: { commentId_userId: { commentId, userId } } });
      if (liked && !existing) await tx.commentLike.create({ data: { commentId, userId } });
      if (!liked && existing) await tx.commentLike.delete({ where: { id: existing.id } });
      if (liked !== !!existing) await enqueueSocial(tx, liked ? 'comment.liked' : 'comment.unliked', userId, postId, commentId);
      const counts = await tx.comment.findUniqueOrThrow({ where: { id: commentId }, select: { _count: { select: { likes: true, replies: { where: { deletedAt: null } } } } } });
      return { commentId, likesCount: counts._count.likes, repliesCount: counts._count.replies, isLikedByCurrentUser: liked };
    });
    await publishActivity(); return result;
  },

  async deleteComment(postId: string, commentId: string, userId: string) {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      const comment = await tx.comment.findFirst({ where: { id: commentId, postId, post: visiblePosts(userId) }, select: { authorId: true, post: { select: { authorId: true } } } });
      if (!comment) throw new NotFoundError('Comment');
      if (comment.authorId !== userId && comment.post.authorId !== userId) throw new ForbiddenError('Cannot delete this comment');
      await tx.comment.updateMany({ where: { id: commentId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: userId } });
      await withdrawActivity(tx, { commentId });
      await enqueueSocial(tx, 'comment.deleted', comment.authorId, postId, commentId);
      return { commentId };
    });
    await publishActivity();
    return result;
  },

  async savePost(postId: string, userId: string) { return this.setSaved(postId, userId, true); },
  async unsavePost(postId: string, userId: string) { return this.setSaved(postId, userId, false); },
  async setSaved(postId: string, userId: string, saved: boolean) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR SHARE`;
      if (!await tx.post.findFirst({ where: { ...visiblePosts(userId), id: postId }, select: { id: true } })) throw new NotFoundError('Post');
      const changed = saved
        ? await tx.savedPost.createMany({ data: [{ userId, postId }], skipDuplicates: true })
        : await tx.savedPost.deleteMany({ where: { userId, postId } });
      if (changed.count) await enqueueSocial(tx, saved ? 'post.bookmarked' : 'post.unbookmarked', userId, postId);
    });
    await publishActivity();
    return { message: saved ? 'Post saved' : 'Post unsaved', ...(await this.getPost(postId, userId)) };
  },

  async getSavedPosts(userId: string, page: number, limit: number, cursor?: string) {
    const after = decodeFeedCursor(cursor);
    const where = { userId, post: visiblePosts(userId) };
    const [rows, total] = await Promise.all([
      prisma.savedPost.findMany({ where: { ...where, ...(after ? { OR: [{ createdAt: { lt: new Date(after.at) } }, { createdAt: new Date(after.at), postId: { lt: after.id } }] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }], skip: after ? 0 : (page - 1) * limit, take: limit + 1, include: { post: { select: postSelect } } }),
      prisma.savedPost.count({ where }),
    ]);
    const more = rows.length > limit, saved = rows.slice(0, limit), last = saved.at(-1);
    return { posts: await enrichPosts(saved.map(s => s.post), userId), total, nextCursor: more && last ? encodeFeedCursor(last.createdAt, last.postId) : undefined };
  },

  async getLikedPosts(userId: string, page: number, limit: number) {
    const [liked, total] = await Promise.all([
      prisma.like.findMany({
        where: { userId, post: visiblePosts(userId) },
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
      prisma.like.count({ where: { userId, post: visiblePosts(userId) } }),
    ]);

    return { posts: await enrichPosts(liked.map(l => l.post), userId), total };
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
        user: { deletedAt: null, accountStatus: 'ACTIVE', OR: [{ isPrivate: false }, { id: userId }] },
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
      select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, isVerified: true, isPrivate: true },
    });
    if (!user) throw new NotFoundError('User');

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where: { authorId: user.id, ...visiblePosts(requesterId) },
        select: postSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.post.count({ where: { authorId: user.id, ...visiblePosts(requesterId) } }),
    ]);

    const enriched = await enrichPosts(posts, requesterId);

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
    const story = await prisma.story.findFirst({
      where: { id: storyId, deletedAt: null, expiresAt: { gt: new Date() },
        user: { deletedAt: null, accountStatus: 'ACTIVE', OR: [{ isPrivate: false }, { id: viewerId }] } },
      select: { userId: true },
    });
    if (!story) throw new NotFoundError('Story');
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

  async recordPostShare(tx: Prisma.TransactionClient, postId: string, actorId: string) {
    await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
    const post = await tx.post.findFirst({ where: { ...visiblePosts(), id: postId }, select: { authorId: true } });
    if (!post) throw new NotFoundError('Post');
    await tx.post.update({ where: { id: postId }, data: { shareCount: { increment: 1 } } });
    await createActivity(tx, { type: 'SHARE', userId: post.authorId, actorId,
      resourceId: postId, content: 'shared your post', dedupeKey: `share:${postId}:${actorId}` });
  },

  async sharePost(postId: string, userId: string, conversationId: string) {
    const post = await prisma.post.findUnique({
      where: { ...visiblePosts(), id: postId },
      select: { id: true, authorId: true, shareCount: true, content: true, imageUrls: true, videoUrl: true },
    });
    if (!post) throw new NotFoundError('Post');

    if (post.authorId === userId) {
      throw new ForbiddenError('Cannot share your own post');
    }

    await messageService.requireMember(conversationId, userId);
    await messageService.sendMessage(conversationId, userId, post.id, undefined, {
      type: 'SHARED_POST', sharedReference: { id: post.id, kind: 'post',
        preview: { content: post.content, imageUrls: post.imageUrls, videoUrl: post.videoUrl } },
    }, tx => this.recordPostShare(tx, postId, userId));

    return { postId, shareCount: (await this.getPost(postId, userId)).shareCount };
  },

  async shareStory(storyId: string, userId: string, conversationId: string) {
    const story = await prisma.story.findFirst({
      where: { id: storyId, deletedAt: null, expiresAt: { gt: new Date() },
        user: { deletedAt: null, accountStatus: 'ACTIVE', OR: [{ isPrivate: false }, { id: userId }] } },
      select: { id: true, userId: true, expiresAt: true },
    });
    if (!story) throw new NotFoundError('Story');

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
      where: { ...visiblePosts(reporterId), id: postId },
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
      where: { ...visiblePosts(), id: postId },
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

    await messageService.sendMessage(conversation.id, senderId, post.id, targetUser.id, {
      type: 'SHARED_POST', sharedReference: { id: post.id, kind: 'post',
        preview: { content: post.content, imageUrls: post.imageUrls, videoUrl: post.videoUrl } },
    }, tx => this.recordPostShare(tx, postId, senderId));

    return { postId, shareCount: (await this.getPost(postId, senderId)).shareCount, conversationId: conversation.id };
  },
};
