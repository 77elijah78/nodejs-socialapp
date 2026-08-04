import { prisma } from '../config/database.js';
import { NotFoundError, ConflictError } from '../utils/errors.js';

export const userService = {
  async getProfile(username: string, requesterId?: string) {
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        isVerified: true,
        createdAt: true,
        _count: { select: { followers: true, following: true, posts: true } },
      },
    });
    if (!user) throw new NotFoundError('User');

    let isFollowing = false;
    if (requesterId) {
      const follow = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: requesterId, followingId: user.id } },
      });
      isFollowing = !!follow;
    }

    return { ...user, isFollowing };
  },

  async searchUsers(query: string, requesterId?: string) {
    if (!query.trim()) return [];

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        isVerified: true,
        _count: { select: { followers: true, following: true, posts: true } },
      },
      take: 20,
    });

    const enriched = await Promise.all(
      users.map(async (u) => {
        let isFollowing = false;
        if (requesterId) {
          const follow = await prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: requesterId, followingId: u.id } },
          });
          isFollowing = !!follow;
        }
        return { ...u, isFollowing };
      }),
    );

    return enriched;
  },

  async updateProfile(
    userId: string,
    data: { displayName?: string; bio?: string; avatarUrl?: string }
  ) {
    return prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, username: true, displayName: true, bio: true, avatarUrl: true },
    });
  },

  async follow(followerId: string, targetUsername: string) {
    const target = await prisma.user.findUnique({ where: { username: targetUsername } });
    if (!target) throw new NotFoundError('User');
    if (target.id === followerId) throw new ConflictError('Cannot follow yourself');

    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId: target.id } },
    });
    if (existing) throw new ConflictError('Already following');

    await prisma.follow.create({ data: { followerId, followingId: target.id } });

    // Create notification
    await prisma.notification.create({
      data: { type: 'FOLLOW', content: 'started following you', userId: target.id, actorId: followerId },
    });

    return { message: `Now following @${targetUsername}` };
  },

  async unfollow(followerId: string, targetUsername: string) {
    const target = await prisma.user.findUnique({ where: { username: targetUsername } });
    if (!target) throw new NotFoundError('User');

    await prisma.follow.deleteMany({
      where: { followerId, followingId: target.id },
    });

    return { message: `Unfollowed @${targetUsername}` };
  },

  async getFollowers(username: string, page: number, limit: number) {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw new NotFoundError('User');

    const [followers, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followingId: user.id },
        include: {
          follower: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.follow.count({ where: { followingId: user.id } }),
    ]);

    return { followers: followers.map((f) => f.follower), total };
  },

  async getFollowing(username: string, page: number, limit: number) {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw new NotFoundError('User');

    const [following, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: user.id },
        include: {
          following: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.follow.count({ where: { followerId: user.id } }),
    ]);

    return { following: following.map((f) => f.following), total };
  },
};
