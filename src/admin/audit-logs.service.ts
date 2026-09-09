import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { buildSearchMode, clamp, parseDate, parseNumber } from './helpers.js';

const csvEscape = (value: unknown): string => {
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${stringValue.replace(/"/g, '""')}"`;
};

export const adminAuditLogsService = {
  async list(query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 50), 1, 200);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const action = typeof query.action === 'string' ? query.action : undefined;
    const targetType = typeof query.targetType === 'string' ? query.targetType : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.AuditLogWhereInput = {
      AND: [
        search
          ? {
              OR: [
                { action: { contains: search, mode: 'insensitive' as const } },
                { targetType: { contains: search, mode: 'insensitive' as const } },
                { reason: { contains: search, mode: 'insensitive' as const } },
                { adminAccount: { user: { username: { contains: search, mode: 'insensitive' as const } } } },
              ],
            }
          : {},
        action ? { action } : {},
        targetType ? { targetType } : {},
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
      prisma.auditLog.findMany({
        where,
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
      prisma.auditLog.count({ where }),
    ]);

    return { items, total, page, limit };
  },

  async exportCsv(query: Record<string, unknown>) {
    const result = await this.list({ ...query, page: 1, limit: 1000 });
    const items = result.items as any[];
    const header = ['timestamp', 'admin', 'action', 'targetType', 'targetId', 'reason', 'metadata'];
    const lines = [header.join(',')];

    for (const item of items) {
      lines.push([
        csvEscape(item.createdAt.toISOString()),
        csvEscape(item.adminAccount?.user.username ?? ''),
        csvEscape(item.action),
        csvEscape(item.targetType),
        csvEscape(item.targetId ?? ''),
        csvEscape(item.reason ?? ''),
        csvEscape(item.metadata ?? ''),
      ].join(','));
    }

    return lines.join('\n');
  },
};
