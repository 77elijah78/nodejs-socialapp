import { Server as HTTPServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { authenticateSocket } from './authenticate.js';
import { logger } from '../config/logger.js';
import { pubClient, subClient } from '../config/redis.js';
import { registerChatHandlers } from './chat.handler.js';
import { registerPushHandlers } from './push.handler.js';
import { registerPresenceHandlers } from './presence.handler.js';

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
  for (const client of [pubClient, subClient]) {
    let recovering = false;
    client.on('reconnecting', () => { recovering = true; });
    client.on('ready', () => {
      if (recovering) {
        io.local.emit('receipts:resync');
        io.local.emit('notifications:sync', { reason: 'adapter-reconnected' });
        io.local.emit('messages:sync', { reason: 'adapter-reconnected' });
      }
      recovering = false;
    });
  }
  logger.info('✅ Socket.io Redis adapter attached');

  // ─── JWT Auth middleware ───────────────────────────────────
  io.use(authenticateSocket);

  // ─── Connection ───────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const authSocket = socket as AuthenticatedSocket;
    logger.info(`🔌 WS connected: ${authSocket.username} [${authSocket.id}]`);

    // Auto-join personal room
    authSocket.join(`user:${authSocket.userId}`);
    authSocket.emit('notifications:sync', { reason: 'connected' });
    authSocket.emit('messages:sync', { reason: 'connected' });

    registerChatHandlers(io, authSocket);
    registerPresenceHandlers(io, authSocket);
    registerPushHandlers(authSocket);

    socket.on('disconnect', (reason) => {
      logger.info(`🔌 WS disconnected: ${authSocket.username} [${reason}]`);
    });

    socket.on('error', (err) => {
      logger.error(`WS error [${authSocket.username}]:`, err);
    });
  });

  return io;
};
