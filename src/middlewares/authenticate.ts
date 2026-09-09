import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { AuthRequest } from '../types/index.js';
import { prisma } from '../config/database.js';
import { redisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

async function touchUserActivity(userId: string): Promise<void> {
  const cacheKey = `user:last-active:${userId}`;

  try {
    const acquired = await redisClient.set(cacheKey, '1', 'EX', 300, 'NX');
    if (acquired === 'OK') {
      await prisma.user.update({
        where: { id: userId },
        data: { lastActiveAt: new Date() },
      });
    }
  } catch (err) {
    logger.warn(`Failed to touch user activity for ${userId}`, err as Error);
  }
}

export const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('No token provided'));
  }

  const token = authHeader.slice(7);

  try {
    const payload: JwtPayload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        username: true,
        email: true,
        accountStatus: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt || user.accountStatus === 'DELETED') {
      throw new UnauthorizedError('Account is no longer available');
    }

    if (user.accountStatus === 'SUSPENDED') {
      throw new ForbiddenError('Account is suspended');
    }

    if (user.accountStatus === 'BANNED') {
      throw new ForbiddenError('Account is banned');
    }

    (req as AuthRequest).user = {
      userId: user.id,
      username: user.username,
      email: user.email,
    };

    void touchUserActivity(user.id);
    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          id: true,
          username: true,
          email: true,
          accountStatus: true,
          deletedAt: true,
        },
      });

      if (user && !user.deletedAt && user.accountStatus === 'ACTIVE') {
        (req as AuthRequest).user = {
          userId: user.id,
          username: user.username,
          email: user.email,
        };
      }
    } catch {
      // silently ignore
    }
  }
  next();
};
