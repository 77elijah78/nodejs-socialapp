import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { createAuditLog } from './audit.js';
import { invalidateCacheByPrefix } from './cache.js';
import { AdminContext } from './types.js';
import { buildSearchMode, clamp, parseDate, parseNumber } from './helpers.js';

export const adminReportsService = {
  async list(query: Record<string, unknown>) {
    const page = Math.max(1, parseNumber(query.page, 1));
    const limit = clamp(parseNumber(query.limit, 20), 1, 100);
    const search = buildSearchMode(typeof query.search === 'string' ? query.search : undefined);
    const status = typeof query.status === 'string' ? query.status : undefined;
    const assignedAdminId = typeof query.assignedAdminId === 'string' ? query.assignedAdminId : undefined;
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const where: Prisma.ReportWhereInput = {
      AND: [
        search
          ? {
              OR: [
                { reason: { contains: search, mode: 'insensitive' as const } },
                { details: { contains: search, mode: 'insensitive' as const } },
                { reporter: { username: { contains: search, mode: 'insensitive' as const } } },
                { post: { author: { username: { contains: search, mode: 'insensitive' as const } } } },
              ],
            }
          : {},
        status ? { status: status as any } : {},
        assignedAdminId ? { assignedAdminId } : {},
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
      prisma.report.findMany({
        where,
        include: {
          reporter: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          post: {
            include: {
              author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
            },
          },
          assignedAdmin: {
            include: {
              user: { select: { id: true, username: true, displayName: true, email: true } },
            },
          },
          notes: {
            include: {
              adminAccount: {
                include: {
                  user: { select: { id: true, username: true, displayName: true } },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.report.count({ where }),
    ]);

    return { items, total, page, limit };
  },

  async getOne(id: string) {
    const report = await prisma.report.findUnique({
      where: { id },
      include: {
        reporter: { select: { id: true, username: true, displayName: true, avatarUrl: true, email: true } },
        post: {
          include: {
            author: { select: { id: true, username: true, displayName: true, avatarUrl: true, email: true } },
            comments: {
              include: {
                author: { select: { id: true, username: true, displayName: true } },
              },
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
        },
        assignedAdmin: {
          include: {
            user: { select: { id: true, username: true, displayName: true, email: true } },
          },
        },
        notes: {
          include: {
            adminAccount: {
              include: {
                user: { select: { id: true, username: true, displayName: true, email: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!report) throw new NotFoundError('Report');

    const history = await prisma.auditLog.findMany({
      where: {
        OR: [
          { targetType: 'REPORT', targetId: id },
          { targetType: 'POST', targetId: report.postId },
          { targetType: 'USER', targetId: report.post.authorId },
        ],
      },
      include: {
        adminAccount: {
          include: {
            user: { select: { id: true, username: true, displayName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { ...report, history };
  },

  async assign(id: string, adminAccountId: string | null | undefined, reason: string | undefined, admin: AdminContext) {
    const report = await prisma.report.update({
      where: { id },
      data: { assignedAdminId: adminAccountId ?? null },
      include: {
        assignedAdmin: {
          include: {
            user: { select: { id: true, username: true, displayName: true, email: true } },
          },
        },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'REPORT_ASSIGNED',
      targetType: 'REPORT',
      targetId: id,
      reason: reason ?? null,
      metadata: { assignedAdminId: adminAccountId ?? null },
    });

    await invalidateCacheByPrefix('admin:dashboard');
    return report;
  },

  async addNote(id: string, note: string, admin: AdminContext) {
    await prisma.report.findUniqueOrThrow({ where: { id } });

    const created = await prisma.reportNote.create({
      data: {
        reportId: id,
        adminAccountId: admin.account.id,
        note,
      },
      include: {
        adminAccount: {
          include: {
            user: { select: { id: true, username: true, displayName: true, email: true } },
          },
        },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'REPORT_NOTE_ADDED',
      targetType: 'REPORT',
      targetId: id,
      reason: note,
    });

    return created;
  },

  async updateStatus(
    id: string,
    payload: { status: 'PENDING' | 'REVIEWED' | 'DISMISSED' | 'ACTION_TAKEN'; note?: string; reason?: string; removePost?: boolean; suspendUser?: boolean; banUser?: boolean },
    admin: AdminContext,
  ) {
    const report = await prisma.report.findUnique({
      where: { id },
      include: { post: true },
    });
    if (!report) throw new NotFoundError('Report');

    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const updatedReport = await tx.report.update({
        where: { id },
        data: {
          status: payload.status,
          reviewedAt: payload.status === 'PENDING' ? null : now,
          reviewedBy: payload.status === 'PENDING' ? null : admin.account.user.username,
          resolutionNote: payload.note ?? report.resolutionNote ?? null,
        },
        include: {
          post: {
            include: {
              author: { select: { id: true, username: true, displayName: true, email: true } },
            },
          },
          reporter: { select: { id: true, username: true, displayName: true, email: true } },
        },
      });

      if (payload.removePost) {
        await tx.post.update({
          where: { id: report.postId },
          data: { deletedAt: now, deletedBy: admin.account.userId },
        });
      }

      if (payload.suspendUser) {
        await tx.user.update({
          where: { id: report.post.authorId },
          data: { accountStatus: 'SUSPENDED', suspendedAt: now, suspendedReason: payload.reason ?? payload.note ?? 'Suspended during report resolution' },
        });
      }

      if (payload.banUser) {
        await tx.user.update({
          where: { id: report.post.authorId },
          data: { accountStatus: 'BANNED', bannedAt: now, bannedReason: payload.reason ?? payload.note ?? 'Banned during report resolution' },
        });
      }

      return updatedReport;
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: `REPORT_${payload.status}`,
      targetType: 'REPORT',
      targetId: id,
      reason: payload.reason ?? payload.note ?? null,
      metadata: {
        removePost: Boolean(payload.removePost),
        suspendUser: Boolean(payload.suspendUser),
        banUser: Boolean(payload.banUser),
      },
    });

    if (payload.removePost) {
      await createAuditLog({
        adminAccountId: admin.account.id,
        action: 'POST_REMOVED',
        targetType: 'POST',
        targetId: report.postId,
        reason: payload.reason ?? payload.note ?? 'Removed via report workflow',
      });
    }

    if (payload.suspendUser) {
      await createAuditLog({
        adminAccountId: admin.account.id,
        action: 'USER_SUSPENDED',
        targetType: 'USER',
        targetId: report.post.authorId,
        reason: payload.reason ?? payload.note ?? 'Suspended via report workflow',
      });
    }

    if (payload.banUser) {
      await createAuditLog({
        adminAccountId: admin.account.id,
        action: 'USER_BANNED',
        targetType: 'USER',
        targetId: report.post.authorId,
        reason: payload.reason ?? payload.note ?? 'Banned via report workflow',
      });
    }

    await invalidateCacheByPrefix('admin:dashboard');
    await invalidateCacheByPrefix('admin:analytics');
    return result;
  },
};
