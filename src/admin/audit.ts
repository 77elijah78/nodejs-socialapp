import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';

export interface AuditLogInput {
  adminAccountId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

export async function createAuditLog(input: AuditLogInput) {
  return prisma.auditLog.create({
    data: {
      adminAccountId: input.adminAccountId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
}
