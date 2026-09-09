import { AdminRole, Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { createAuditLog } from './audit.js';
import { invalidateCacheByPrefix } from './cache.js';
import { AdminContext } from './types.js';
import { canManageRole, normalizePermissions } from './permissions.js';
import { buildSearchMode, clamp, parseDate, parseNumber } from './helpers.js';

function userOrderBy(sort: string, direction: Prisma.SortOrder): Prisma.UserOrderByWithRelationInput {
  switch (sort) {
    case 'username':
      return { username: direction };
    case 'lastActiveAt':
      return { lastActiveAt: direction };
    default:
      return { createdAt: direction };
  }
}

function mapRole(adminRole?: AdminRole | null) {
  return adminRole ?? 'USER';
}

export const adminUsersService = {
  async listUsers(query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const status = typeof query.status === 'string' ? query.status : undefined;
    const role = typeof query.role === 'string' ? query.role : undefined;
    const registeredFrom = parseDate(query.registeredFrom);
    const registeredTo = parseDate(query.registeredTo);
    const activeFrom = parseDate(query.activeFrom);
    const sort = typeof query.sort === 'string' ? query.sort : 'createdAt';
    const direction: Prisma.SortOrder = query.direction === 'asc' ? 'asc' : 'desc';

    const where: Prisma.UserWhereInput = {
      AND: [
        search
          ? {
              OR: [
                { username: { contains: search, mode: 'insensitive' } },
                { displayName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {},
        status ? { accountStatus: status as any } : {},
        role
          ? role === 'USER'
            ? { adminAccount: { is: null } }
            : { adminAccount: { is: { role: role as AdminRole } } }
          : {},
        registeredFrom || registeredTo
          ? {
              createdAt: {
                ...(registeredFrom ? { gte: registeredFrom } : {}),
                ...(registeredTo ? { lte: registeredTo } : {}),
              },
            }
          : {},
        activeFrom ? { lastActiveAt: { gte: activeFrom } } : {},
      ],
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: userOrderBy(sort, direction),
        include: {
          adminAccount: true,
          _count: {
            select: {
              posts: true,
              comments: true,
              followers: true,
              following: true,
              stories: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      users: users.map((user) => ({
        ...user,
        role: mapRole(user.adminAccount?.role),
      })),
      total,
      page,
      limit,
    };
  },

  async getUser(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        adminAccount: true,
        _count: {
          select: {
            posts: true,
            stories: true,
            comments: true,
            likes: true,
            followers: true,
            following: true,
            reports: true,
            refreshTokens: true,
          },
        },
      },
    });

    if (!user) throw new NotFoundError('User');

    const reportsAgainstUser = await prisma.report.count({
      where: { post: { authorId: id } },
    });

    return {
      ...user,
      role: mapRole(user.adminAccount?.role),
      reportsAgainstUser,
    };
  },

  async getUserPosts(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const posts = await prisma.post.findMany({
      where: { authorId: id },
      include: {
        author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        _count: { select: { likes: true, comments: true, reports: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await prisma.post.count({ where: { authorId: id } });
    return { items: posts, total, page, limit };
  },

  async getUserStories(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [items, total] = await Promise.all([
      prisma.story.findMany({
        where: { userId: id },
        include: {
          views: { select: { viewerId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.story.count({ where: { userId: id } }),
    ]);

    return { items, total, page, limit };
  },

  async getUserComments(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [items, total] = await Promise.all([
      prisma.comment.findMany({
        where: { authorId: id },
        include: {
          post: { select: { id: true, content: true, authorId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.comment.count({ where: { authorId: id } }),
    ]);

    return { items, total, page, limit };
  },

  async getUserLikes(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [items, total] = await Promise.all([
      prisma.like.findMany({
        where: { userId: id },
        include: {
          post: {
            select: {
              id: true,
              content: true,
              author: { select: { id: true, username: true, displayName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.like.count({ where: { userId: id } }),
    ]);
    return { items, total, page, limit };
  },

  async getUserFollowers(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [items, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followingId: id },
        include: {
          follower: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.follow.count({ where: { followingId: id } }),
    ]);
    return { items: items.map((item) => item.follower), total, page, limit };
  },

  async getUserFollowing(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [items, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: id },
        include: {
          following: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.follow.count({ where: { followerId: id } }),
    ]);
    return { items: items.map((item) => item.following), total, page, limit };
  },

  async getUserReports(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [filedByUser, reportsAgainstUser, totalFiled, totalAgainst] = await Promise.all([
      prisma.report.findMany({
        where: { reporterId: id },
        include: {
          post: { include: { author: { select: { id: true, username: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.report.findMany({
        where: { post: { authorId: id } },
        include: {
          reporter: { select: { id: true, username: true, displayName: true } },
          post: { select: { id: true, content: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.report.count({ where: { reporterId: id } }),
      prisma.report.count({ where: { post: { authorId: id } } }),
    ]);

    return {
      filedByUser: { items: filedByUser, total: totalFiled },
      reportsAgainstUser: { items: reportsAgainstUser, total: totalAgainst },
      page,
      limit,
    };
  },

  async getModerationHistory(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { targetType: 'USER', targetId: id },
        include: {
          adminAccount: {
            include: {
              user: { select: { id: true, username: true, displayName: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where: { targetType: 'USER', targetId: id } }),
    ]);

    return { items, total, page, limit };
  },

  async getLoginActivity(id: string, query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const [refreshTokens, total] = await Promise.all([
      prisma.refreshToken.findMany({
        where: { userId: id },
        select: { id: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.refreshToken.count({ where: { userId: id } }),
    ]);

    return { items: refreshTokens, total, page, limit };
  },

  async applyAction(id: string, action: string, reason: string, admin: AdminContext) {
    const user = await prisma.user.findUnique({
      where: { id },
      include: { adminAccount: true },
    });

    if (!user) throw new NotFoundError('User');

    if (user.adminAccount && !canManageRole(admin.account.role, user.adminAccount.role)) {
      throw new ConflictError('You cannot manage an admin with an equal or higher role');
    }

    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      switch (action) {
        case 'suspend':
          return tx.user.update({
            where: { id },
            data: { accountStatus: 'SUSPENDED', suspendedAt: now, suspendedReason: reason },
          });
        case 'unsuspend':
          return tx.user.update({
            where: { id },
            data: { accountStatus: 'ACTIVE', suspendedAt: null, suspendedReason: null },
          });
        case 'ban':
          return tx.user.update({
            where: { id },
            data: { accountStatus: 'BANNED', bannedAt: now, bannedReason: reason },
          });
        case 'unban':
          return tx.user.update({
            where: { id },
            data: { accountStatus: 'ACTIVE', bannedAt: null, bannedReason: null },
          });
        case 'delete':
          return tx.user.update({
            where: { id },
            data: { accountStatus: 'DELETED', deletedAt: now },
          });
        case 'restore':
          return tx.user.update({
            where: { id },
            data: { accountStatus: 'ACTIVE', deletedAt: null, suspendedAt: null, suspendedReason: null, bannedAt: null, bannedReason: null },
          });
        case 'verify':
          return tx.user.update({ where: { id }, data: { isVerified: true } });
        case 'unverify':
          return tx.user.update({ where: { id }, data: { isVerified: false } });
        default:
          throw new ConflictError(`Unsupported action: ${action}`);
      }
    });

    const actionMap: Record<string, string> = {
      suspend: 'USER_SUSPENDED',
      unsuspend: 'USER_UNSUSPENDED',
      ban: 'USER_BANNED',
      unban: 'USER_UNBANNED',
      delete: 'USER_DELETED',
      restore: 'USER_RESTORED',
      verify: 'USER_VERIFIED',
      unverify: 'USER_UNVERIFIED',
    };

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: actionMap[action],
      targetType: 'USER',
      targetId: id,
      reason,
      metadata: {
        username: user.username,
        email: user.email,
      },
    });

    await invalidateCacheByPrefix('admin:dashboard');
    await invalidateCacheByPrefix('admin:analytics');

    return updated;
  },

  async grantOrUpdateAdminRole(targetUserId: string, role: AdminRole, permissions: string[] | undefined, reason: string, admin: AdminContext) {
    if (!canManageRole(admin.account.role, role)) {
      throw new ConflictError('You cannot assign a role equal to or higher than your own');
    }

    const user = await prisma.user.findUnique({ where: { id: targetUserId }, include: { adminAccount: true } });
    if (!user) throw new NotFoundError('User');

    if (user.adminAccount && !canManageRole(admin.account.role, user.adminAccount.role)) {
      throw new ConflictError('You cannot change this admin role');
    }

    const account = await prisma.adminAccount.upsert({
      where: { userId: targetUserId },
      update: {
        role,
        permissions: normalizePermissions(permissions),
        isActive: true,
        disabledAt: null,
      },
      create: {
        userId: targetUserId,
        role,
        permissions: normalizePermissions(permissions),
        createdByUserId: admin.account.userId,
      },
      include: {
        user: { select: { id: true, username: true, email: true, displayName: true, accountStatus: true } },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'USER_ROLE_CHANGED',
      targetType: 'USER',
      targetId: targetUserId,
      reason,
      metadata: {
        role,
        permissions: normalizePermissions(permissions),
      },
    });

    return account;
  },
};
