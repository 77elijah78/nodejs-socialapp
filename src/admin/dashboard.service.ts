import { prisma } from '../config/database.js';
import { getOrSetCache } from './cache.js';
import { adminAnalyticsService } from './analytics.service.js';
import { adminSystemService } from './system.service.js';

const countValue = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
};

export const adminDashboardService = {
  async getOverview() {
    return getOrSetCache('admin:dashboard:overview', 60, async () => {
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [
        totalUsers,
        activeUsers,
        dailyActiveUsers,
        newUsers,
        totalPosts,
        totalStories,
        totalComments,
        totalLikes,
        totalMessages,
        pendingReports,
        suspendedUsers,
        recentModeration,
        shareAggregate,
      ] = await Promise.all([
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.user.count({ where: { deletedAt: null, lastActiveAt: { gte: last30d } } }),
        prisma.user.count({ where: { deletedAt: null, lastActiveAt: { gte: last24h } } }),
        prisma.user.count({ where: { deletedAt: null, createdAt: { gte: last7d } } }),
        prisma.post.count({ where: { deletedAt: null } }),
        prisma.story.count({ where: { deletedAt: null } }),
        prisma.comment.count({ where: { deletedAt: null } }),
        prisma.like.count(),
        prisma.message.count(),
        prisma.report.count({ where: { status: 'PENDING' } }),
        prisma.user.count({ where: { accountStatus: 'SUSPENDED' } }),
        prisma.auditLog.findMany({
          include: {
            adminAccount: {
              include: {
                user: { select: { id: true, username: true, email: true, displayName: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        prisma.$queryRawUnsafe<Array<{ count: unknown }>>('SELECT COALESCE(SUM(share_count), 0)::bigint AS count FROM posts'),
      ]);

      const [userGrowth, activeUsersSeries, reportsSeries, contentSeries, engagementSeries, systemHealth] = await Promise.all([
        adminAnalyticsService.getTimeSeries(['users'], 'daily', last30d, now),
        adminAnalyticsService.getTimeSeries(['active_users'], 'daily', last30d, now),
        adminAnalyticsService.getTimeSeries(['reports'], 'daily', last30d, now),
        adminAnalyticsService.getTimeSeries(['posts', 'stories', 'comments'], 'daily', last30d, now),
        adminAnalyticsService.getTimeSeries(['likes', 'shares', 'messages'], 'daily', last30d, now),
        adminSystemService.getOverview(),
      ]);

      return {
        summary: {
          totalUsers,
          activeUsers,
          dailyActiveUsers,
          newUsers,
          totalPosts,
          totalStories,
          totalComments,
          totalLikes,
          totalShares: countValue(shareAggregate[0]?.count ?? 0),
          totalMessages,
          reportsAwaitingReview: pendingReports,
          suspendedUsers,
        },
        charts: {
          userGrowth: userGrowth.users,
          dailyActiveUsers: activeUsersSeries.active_users,
          reportsOverTime: reportsSeries.reports,
          contentCreation: contentSeries,
          engagementOverTime: engagementSeries,
        },
        recentModeration,
        systemHealth,
      };
    });
  },
};
