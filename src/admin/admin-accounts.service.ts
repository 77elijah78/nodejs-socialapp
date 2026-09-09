import bcrypt from 'bcryptjs';
import { AdminRole } from '@prisma/client';
import { prisma } from '../config/database.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { createAuditLog } from './audit.js';
import { AdminContext } from './types.js';
import { canManageRole, normalizePermissions, resolvePermissions } from './permissions.js';

export const adminAccountsService = {
  async list() {
    const accounts = await prisma.adminAccount.findMany({
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            accountStatus: true,
            isVerified: true,
            lastActiveAt: true,
            createdAt: true,
          },
        },
      },
      orderBy: [{ role: 'desc' }, { createdAt: 'desc' }],
    });

    return accounts.map((account) => ({
      ...account,
      resolvedPermissions: resolvePermissions(account.role, account.permissions),
    }));
  },

  async create(
    payload: {
      existingUserId?: string;
      username?: string;
      email?: string;
      password?: string;
      displayName?: string;
      role: AdminRole;
      permissions?: string[];
    },
    admin: AdminContext,
  ) {
    if (!canManageRole(admin.account.role, payload.role)) {
      throw new ConflictError('You cannot assign a role equal to or higher than your own');
    }

    let userId = payload.existingUserId;

    if (userId) {
      const existingUser = await prisma.user.findUnique({ where: { id: userId }, include: { adminAccount: true } });
      if (!existingUser) throw new NotFoundError('User');
      if (existingUser.adminAccount) throw new ConflictError('User already has an admin account');
    } else {
      const existing = await prisma.user.findFirst({
        where: {
          OR: [{ email: payload.email }, { username: payload.username }],
        },
      });
      if (existing) throw new ConflictError('A user already exists with that email or username');

      const passwordHash = await bcrypt.hash(payload.password!, 12);
      const user = await prisma.user.create({
        data: {
          username: payload.username!,
          email: payload.email!,
          passwordHash,
          displayName: payload.displayName,
          lastActiveAt: new Date(),
        },
      });
      userId = user.id;
    }

    const account = await prisma.adminAccount.create({
      data: {
        userId: userId!,
        role: payload.role,
        permissions: normalizePermissions(payload.permissions),
        createdByUserId: admin.account.userId,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            accountStatus: true,
            isVerified: true,
            lastActiveAt: true,
            createdAt: true,
          },
        },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'ADMIN_CREATED',
      targetType: 'ADMIN_ACCOUNT',
      targetId: account.id,
      metadata: {
        userId: account.userId,
        role: account.role,
        permissions: normalizePermissions(payload.permissions),
      },
    });

    return {
      ...account,
      resolvedPermissions: resolvePermissions(account.role, account.permissions),
    };
  },

  async update(id: string, payload: { role?: AdminRole; permissions?: string[]; isActive?: boolean; reason?: string }, admin: AdminContext) {
    const existing = await prisma.adminAccount.findUnique({ where: { id }, include: { user: true } });
    if (!existing) throw new NotFoundError('Admin account');

    if (!canManageRole(admin.account.role, existing.role)) {
      throw new ConflictError('You cannot modify an admin with an equal or higher role');
    }

    if (payload.role && !canManageRole(admin.account.role, payload.role)) {
      throw new ConflictError('You cannot assign a role equal to or higher than your own');
    }

    const updated = await prisma.adminAccount.update({
      where: { id },
      data: {
        role: payload.role,
        permissions: payload.permissions ? normalizePermissions(payload.permissions) : undefined,
        isActive: payload.isActive,
        disabledAt: payload.isActive === false ? new Date() : payload.isActive === true ? null : undefined,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            accountStatus: true,
            isVerified: true,
            lastActiveAt: true,
            createdAt: true,
          },
        },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'ADMIN_UPDATED',
      targetType: 'ADMIN_ACCOUNT',
      targetId: id,
      reason: payload.reason ?? null,
      metadata: {
        role: updated.role,
        permissions: updated.permissions,
        isActive: updated.isActive,
      },
    });

    return {
      ...updated,
      resolvedPermissions: resolvePermissions(updated.role, updated.permissions),
    };
  },

  async disable(id: string, reason: string, admin: AdminContext) {
    const existing = await prisma.adminAccount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Admin account');
    if (!canManageRole(admin.account.role, existing.role)) {
      throw new ConflictError('You cannot disable an admin with an equal or higher role');
    }

    const updated = await prisma.adminAccount.update({
      where: { id },
      data: { isActive: false, disabledAt: new Date() },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            accountStatus: true,
          },
        },
      },
    });

    await createAuditLog({
      adminAccountId: admin.account.id,
      action: 'ADMIN_DISABLED',
      targetType: 'ADMIN_ACCOUNT',
      targetId: id,
      reason,
    });

    return {
      ...updated,
      resolvedPermissions: resolvePermissions(updated.role, updated.permissions),
    };
  },
};
