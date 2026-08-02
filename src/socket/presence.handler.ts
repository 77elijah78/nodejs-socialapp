import { Server } from 'socket.io';
import { AuthenticatedSocket } from './index.js';
import { logger } from '../config/logger.js';

// In-memory online users map (swap for Redis in production)
const onlineUsers = new Map<string, { socketId: string; lastSeen: Date }>();

export const isUserOnline = (userId: string): boolean => onlineUsers.has(userId);

export const registerPresenceHandlers = (io: Server, socket: AuthenticatedSocket): void => {
  // Mark user as online
  onlineUsers.set(socket.userId, { socketId: socket.id, lastSeen: new Date() });

  // Broadcast to all clients
  io.emit('presence:online', { userId: socket.userId, username: socket.username });

  logger.debug(`👤 Online users: ${onlineUsers.size}`);

  // Handle disconnect
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.userId);
    io.emit('presence:offline', { userId: socket.userId, lastSeen: new Date() });
    logger.debug(`👤 Online users: ${onlineUsers.size}`);
  });

  // Request list of online users
  socket.on('presence:list', (callback: (users: string[]) => void) => {
    callback([...onlineUsers.keys()]);
  });

  // Heartbeat / keep-alive
  socket.on('presence:ping', () => {
    if (onlineUsers.has(socket.userId)) {
      onlineUsers.set(socket.userId, { socketId: socket.id, lastSeen: new Date() });
    }
    socket.emit('presence:pong');
  });
};
