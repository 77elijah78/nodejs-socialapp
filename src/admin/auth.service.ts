import { prisma } from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { resolvePermissions } from './permissions.js';

export const adminAuthService = {
  async getSession(userId: string) {
    const adminAccount = await prisma.adminAccount.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            isVerified: true,
            accountStatus: true,
            createdAt: true,
            lastActiveAt: true,
          },
        },
      },
    });

    if (!adminAccount || !adminAccount.isActive) {
      throw new NotFoundError('Admin account');
    }

    await prisma.adminAccount.update({
      where: { id: adminAccount.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      adminAccount: {
        ...adminAccount,
        permissions: resolvePermissions(adminAccount.role, adminAccount.permissions),
      },
    };
  },
};
