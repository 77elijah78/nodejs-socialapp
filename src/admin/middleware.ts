import { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { AuthRequest } from '../types/index.js';
import { AdminPermission, hasPermission, resolvePermissions } from './permissions.js';
import { AdminRequest } from './types.js';

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const adminAccount = await prisma.adminAccount.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            accountStatus: true,
          },
        },
      },
    });

    if (!adminAccount || !adminAccount.isActive) {
      throw new ForbiddenError('Admin access required');
    }

    const permissions = resolvePermissions(adminAccount.role, adminAccount.permissions);
    (req as AdminRequest).admin = { account: adminAccount, permissions };
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(permission: AdminPermission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const adminReq = req as AdminRequest;
    if (!adminReq.admin || !hasPermission(adminReq.admin.permissions, permission)) {
      return next(new ForbiddenError(`Missing permission: ${permission}`));
    }
    next();
  };
}
