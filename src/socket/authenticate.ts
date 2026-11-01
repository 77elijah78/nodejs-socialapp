import type { Socket } from 'socket.io';
import { prisma } from '../config/database.js';
import { verifyToken } from '../utils/jwt.js';
import type { AuthenticatedSocket } from './index.js';

export async function authenticateSocket(socket: Socket, next: (error?: Error) => void): Promise<void> {
  const token = socket.handshake.auth?.token ?? socket.handshake.headers.authorization?.replace('Bearer ', '');
  if (typeof token !== 'string' || !token) return next(new Error('Authentication required'));
  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.userId },
      select: { accountStatus: true, deletedAt: true, username: true } });
    if (!user || user.deletedAt || user.accountStatus !== 'ACTIVE') return next(new Error('Account is unavailable'));
    Object.assign(socket as AuthenticatedSocket, { userId: payload.userId, username: user.username });
    next();
  } catch { next(new Error('Invalid token')); }
}
