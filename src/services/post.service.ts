import { prisma } from '../config/database.js';
import { NotFoundError, ForbiddenError, ConflictError } from '../utils/errors.js';

const postSelect = {
  id: true,
  content: true,
  imageUrls: true,
  videoUrl: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } },
  _count: { select: { likes: true, comments: true } },
};

const commentSelect = {
  id: true,
  content: true,
  createdAt: true,
  repliedToId: true,
  author: { select: { id: true, username: true, avatarUrl: true } },
};

export const postService = {
  async createPost(authorId: string, data: { content: string; imageUrls?: string[]; videoUrl?: string | null }) {
    return prisma.post.create({
      data: { ...data, authorId },
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
        orderBy: { createdAt: 'desc' },
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

  async updatePost(postId: string, userId: string, data: { content?: string; imageUrls?: string[]; videoUrl?: string | null }) {
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
    const post = await prisma.post.findUnique({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundError('Post');

    const existing = await prisma.like.findUnique({
      where: { userId_postId: { userId, postId } },
    });
    if (existing) throw new ConflictError('Already liked');

    await prisma.like.create({ data: { userId, postId } });

    if (post.authorId !== userId) {
      await prisma.notification.create({
        data: { type: 'LIKE', content: 'liked your post', userId: post.authorId, actorId: userId, resourceId: postId },
      });
    }

    return { message: 'Post liked' };
  },

  async unlikePost(postId: string, userId: string) {
    await prisma.like.deleteMany({ where: { userId, postId } });
    return { message: 'Post unliked' };
  },

  async addComment(postId: string, authorId: string, content: string, repliedToId?: string | null) {
    const post = await prisma.post.findUnique({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundError('Post');

    const comment = await prisma.comment.create({
      data: { content, authorId, postId, repliedToId: repliedToId ?? null },
      select: commentSelect,
    });

    if (post.authorId !== authorId) {
      await prisma.notification.create({
        data: { type: 'COMMENT', content: 'commented on your post', userId: post.authorId, actorId: authorId, resourceId: postId },
      });
    }

    return comment;
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
        where: { userId },
        orderBy: { createdAt: 'desc' },
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
      prisma.savedPost.count({ where: { userId } }),
    ]);

    return { posts: saved.map((s) => s.post), total };
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
      },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        views: { where: { viewerId: userId } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return stories;
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
      select: { userId: true },
    });
    if (!story) {
      throw new NotFoundError("Story not found");
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
};
