import { Server } from 'socket.io';
import { AuthenticatedSocket } from './index.js';
import { messageService } from '../services/message.service.js';
import { logger } from '../config/logger.js';

interface SendMessagePayload {
  conversationId: string;
  content: string;
  receiverId?: string;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  type?: string;
  duration?: number | null;
  repliedToId?: string | null;
  forwardedFromId?: string | null;
}

interface ReplyPayload {
  conversationId: string;
  content: string;
  repliedToId: string;
  receiverId?: string;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  type?: string;
  duration?: number | null;
}

interface TypingPayload {
  conversationId: string;
  isTyping: boolean;
}

interface ReadPayload {
  conversationId: string;
  messageId?: string;
}

interface DeliveredPayload {
  conversationId: string;
  messageIds: string[];
}

interface EditPayload {
  conversationId: string;
  messageId: string;
  content: string;
}

interface DeletePayload {
  conversationId: string;
  messageId: string;
  deleteFor: 'me' | 'everyone';
}

interface DeleteConversationPayload {
  conversationId: string;
}

interface ForwardPayload {
  conversationId: string;
  messageId: string;
  targetConversationId: string;
}

export const registerChatHandlers = (io: Server, socket: AuthenticatedSocket): void => {
  // Join a conversation room
  socket.on('conversation:join', (conversationId: string) => {
    socket.join(`conversation:${conversationId}`);
    logger.debug(`${socket.username} joined conversation:${conversationId}`);
  });

  // Leave a conversation room
  socket.on('conversation:leave', (conversationId: string) => {
    socket.leave(`conversation:${conversationId}`);
  });

  // Delete (archive) a conversation for the current user
  socket.on('conversation:delete', async (payload: DeleteConversationPayload, ack?: Function) => {
    try {
      await messageService.deleteConversation(payload.conversationId, socket.userId);
      socket.leave(`conversation:${payload.conversationId}`);
      ack?.({ success: true, conversationId: payload.conversationId });
    } catch (err) {
      logger.error('conversation:delete error', err);
      ack?.({ success: false, error: (err as Error).message });
    }
  });

  // Send message via WebSocket
  socket.on('message:send', async (payload: SendMessagePayload, ack?: Function) => {
    try {
      const { conversationId, content, receiverId, mediaUrl, thumbnailUrl, type, duration, repliedToId, forwardedFromId } = payload;

      const message = await messageService.sendMessage(
        conversationId,
        socket.userId,
        content ?? '',
        receiverId,
        { mediaUrl, thumbnailUrl, type: type as any, duration, repliedToId, forwardedFromId }
      );

      ack?.({ success: true, messageId: message.id });
    } catch (err) {
      logger.error('message:send error', err);
      ack?.({ success: false, error: (err as Error).message });
    }
  });

  // Reply to a message via WebSocket
  socket.on('message:reply', async (payload: ReplyPayload, ack?: Function) => {
    try {
      const { conversationId, content, repliedToId, receiverId, mediaUrl, thumbnailUrl, type, duration } = payload;

      const message = await messageService.replyMessage(
        conversationId,
        socket.userId,
        content,
        repliedToId,
        receiverId,
        { mediaUrl, thumbnailUrl, type: type as any, duration }
      );

      ack?.({ success: true, messageId: message.id });
    } catch (err) {
      logger.error('message:reply error', err);
      ack?.({ success: false, error: (err as Error).message });
    }
  });

  // Typing indicator
  socket.on('message:typing', (payload: TypingPayload) => {
    socket
      .to(`conversation:${payload.conversationId}`)
      .emit('message:typing', {
        userId: socket.userId,
        username: socket.username,
        isTyping: payload.isTyping,
        conversationId: payload.conversationId,
      });
  });

  // Mark messages as read
  socket.on('message:read', async (payload: ReadPayload) => {
    try {
      if (payload.messageId) {
        await messageService.markMessageRead(payload.conversationId, socket.userId, payload.messageId);
      } else {
        await messageService.markMessagesRead(payload.conversationId, socket.userId);
      }
    } catch (err) {
      logger.error('message:read error', err);
    }
  });

  // Mark messages as delivered
  socket.on('message:delivered', async (payload: DeliveredPayload) => {
    try {
      await messageService.markMessagesDelivered(payload.messageIds, socket.userId);
    } catch (err) {
      logger.error('message:delivered error', err);
    }
  });

  // Edit message via WebSocket
  socket.on('message:edit', async (payload: EditPayload, ack?: Function) => {
    try {
      const message = await messageService.editMessage(payload.messageId, socket.userId, payload.content);
      ack?.({ success: true, messageId: message.id });
    } catch (err) {
      logger.error('message:edit error', err);
      ack?.({ success: false, error: (err as Error).message });
    }
  });

  // Delete message via WebSocket
  socket.on('message:delete', async (payload: DeletePayload, ack?: Function) => {
    try {
      const result = await messageService.deleteMessage(payload.messageId, socket.userId, payload.deleteFor);
      ack?.({ success: true, messageId: payload.messageId });
    } catch (err) {
      logger.error('message:delete error', err);
      ack?.({ success: false, error: (err as Error).message });
    }
  });

  // Forward message via WebSocket
  socket.on('message:forward', async (payload: ForwardPayload, ack?: Function) => {
    try {
      const forwarded = await messageService.forwardMessage(payload.messageId, socket.userId, payload.targetConversationId);
      ack?.({ success: true, messageId: forwarded.id, targetConversationId: payload.targetConversationId });
    } catch (err) {
      logger.error('message:forward error', err);
      ack?.({ success: false, error: (err as Error).message });
    }
  });

  // Join personal room for direct notifications
  socket.on('presence:join-personal', (_data: unknown, ack?: Function) => {
    socket.join(`user:${socket.userId}`);
    ack?.({ success: true });
  });
};
