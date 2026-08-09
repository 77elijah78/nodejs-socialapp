import { Server as HTTPServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyToken } from '../utils/jwt.js';
import { logger } from '../config/logger.js';
import { pubClient, subClient } from '../config/redis.js';
import { registerChatHandlers } from './chat.handler.js';
import { registerPresenceHandlers } from './presence.handler.js';
import { messageService } from '../services/message.service.js';

export interface AuthenticatedSocket extends Socket {
  userId: string;
  username: string;
}

let io: Server;

export const getIO = (): Server => {
  if (!io) throw new Error('Socket.io not initialised');
  return io;
};

export const initSocket = async (httpServer: HTTPServer): Promise<Server> => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN ?? '*',
      credentials: true,
    },
    pingTimeout: 20_000,
    pingInterval: 10_000,
  });

  // ─── Redis adapter for horizontal scaling ─────────────────
  // Multiple pods can now share Socket.io rooms across instances
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('✅ Socket.io Redis adapter attached');

  // ─── JWT Auth middleware ───────────────────────────────────
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ??
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = verifyToken(token);
      (socket as AuthenticatedSocket).userId = payload.userId;
      (socket as AuthenticatedSocket).username = payload.username;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection ───────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const authSocket = socket as AuthenticatedSocket;
    logger.info(`🔌 WS connected: ${authSocket.username} [${authSocket.id}]`);

    // Auto-join personal room
    authSocket.join(`user:${authSocket.userId}`);

    messageService.markAllMessagesDelivered(authSocket.userId).catch((err) => {
      logger.error('markAllMessagesDelivered error', err);
    });

    registerChatHandlers(io, authSocket);
    registerPresenceHandlers(io, authSocket);

    socket.on('disconnect', (reason) => {
      logger.info(`🔌 WS disconnected: ${authSocket.username} [${reason}]`);
    });

    socket.on('error', (err) => {
      logger.error(`WS error [${authSocket.username}]:`, err);
    });
  });

  return io;
};
