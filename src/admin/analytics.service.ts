import { prisma } from '../config/database.js';
import { getOrSetCache } from './cache.js';

export type AnalyticsGranularity = 'daily' | 'weekly' | 'monthly';
export type AnalyticsMetric =
  | 'users'
  | 'active_users'
  | 'posts'
  | 'stories'
  | 'comments'
  | 'likes'
  | 'shares'
  | 'messages'
  | 'reports'
  | 'resolved_reports'
  | 'suspensions'
  | 'bans';

const GRANULARITY_SQL: Record<AnalyticsGranularity, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

const countValue = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
};

async function queryCount(sql: string, from: Date, to: Date): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: unknown }>>(sql, from, to);
  return countValue(rows[0]?.count ?? 0);
}

async function querySeries(metric: AnalyticsMetric, granularity: AnalyticsGranularity, from: Date, to: Date) {
  const bucket = GRANULARITY_SQL[granularity];

  const sqlMap: Record<AnalyticsMetric, string> = {
    users: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM users
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    active_users: `
      SELECT DATE_TRUNC('${bucket}', last_active_at) AS bucket, COUNT(*)::bigint AS count
      FROM users
      WHERE last_active_at IS NOT NULL AND last_active_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    posts: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM posts
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    stories: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM stories
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    comments: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM comments
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    likes: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM likes
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    shares: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COALESCE(SUM(share_count), 0)::bigint AS count
      FROM posts
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    messages: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM messages
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    reports: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM reports
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    resolved_reports: `
      SELECT DATE_TRUNC('${bucket}', reviewed_at) AS bucket, COUNT(*)::bigint AS count
      FROM reports
      WHERE reviewed_at IS NOT NULL AND reviewed_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    suspensions: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM audit_logs
      WHERE action = 'USER_SUSPENDED' AND created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    bans: `
      SELECT DATE_TRUNC('${bucket}', created_at) AS bucket, COUNT(*)::bigint AS count
      FROM audit_logs
      WHERE action = 'USER_BANNED' AND created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 ASC
    `,
  };

  const rows = await prisma.$queryRawUnsafe<Array<{ bucket: Date; count: unknown }>>(sqlMap[metric], from, to);
  return rows.map((row) => ({
    bucket: row.bucket instanceof Date ? row.bucket.toISOString() : new Date(row.bucket).toISOString(),
    count: countValue(row.count),
  }));
}

export const adminAnalyticsService = {
  async getSummary(from: Date, to: Date) {
    const key = `admin:analytics:summary:${from.toISOString()}:${to.toISOString()}`;
    return getOrSetCache(key, 300, async () => {
      const [
        newRegistrations,
        postsCreated,
        storiesCreated,
        commentsCreated,
        likesCreated,
        messagesSent,
        reportsCreated,
        reportsResolved,
        suspensions,
        bans,
      ] = await Promise.all([
        queryCount('SELECT COUNT(*)::bigint AS count FROM users WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM posts WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM stories WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM comments WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM likes WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM messages WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM reports WHERE created_at BETWEEN $1 AND $2', from, to),
        queryCount('SELECT COUNT(*)::bigint AS count FROM reports WHERE reviewed_at IS NOT NULL AND reviewed_at BETWEEN $1 AND $2', from, to),
        queryCount("SELECT COUNT(*)::bigint AS count FROM audit_logs WHERE action = 'USER_SUSPENDED' AND created_at BETWEEN $1 AND $2", from, to),
        queryCount("SELECT COUNT(*)::bigint AS count FROM audit_logs WHERE action = 'USER_BANNED' AND created_at BETWEEN $1 AND $2", from, to),
      ]);

      const rows = await prisma.$queryRawUnsafe<Array<{ count: unknown }>>(
        'SELECT COALESCE(SUM(share_count), 0)::bigint AS count FROM posts WHERE created_at BETWEEN $1 AND $2',
        from,
        to,
      );

      return {
        newRegistrations,
        postsCreated,
        storiesCreated,
        commentsCreated,
        likesCreated,
        sharesCreated: countValue(rows[0]?.count ?? 0),
        messagesSent,
        reportsCreated,
        reportsResolved,
        suspensions,
        bans,
      };
    });
  },

  async getTimeSeries(metrics: AnalyticsMetric[], granularity: AnalyticsGranularity, from: Date, to: Date) {
    const key = `admin:analytics:timeseries:${metrics.sort().join(',')}:${granularity}:${from.toISOString()}:${to.toISOString()}`;
    return getOrSetCache(key, 300, async () => {
      const seriesEntries = await Promise.all(
        metrics.map(async (metric) => [metric, await querySeries(metric, granularity, from, to)] as const),
      );

      return Object.fromEntries(seriesEntries);
    });
  },
};
