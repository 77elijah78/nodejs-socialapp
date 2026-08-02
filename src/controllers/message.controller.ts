import { Request, Response, NextFunction } from 'express';
import { messageService } from '../services/message.service.js';
import { sendSuccess, buildPaginationMeta } from '../utils/response.js';
import { AuthRequest, parsePagination } from '../types/index.js';

function getParamValue(param: string | string[]): string {
  if (Array.isArray(param)) {
    return param[0] || '';
  }
  return param || '';
}

export const messageController = {
  async getConversations(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const conversations = await messageService.getUserConversations(userId);
      sendSuccess(res, conversations);
    } catch (err) {
      next(err);
    }
  },

  async startConversation(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const conversation = await messageService.getOrCreateConversation(userId, req.body.userId);
      sendSuccess(res, conversation, 'Conversation ready', 201);
    } catch (err) {
      next(err);
    }
  },

  async getMessages(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const { page, limit } = parsePagination(req.query);

      const conversationId = getParamValue(req.params.conversationId);

      if (!conversationId) {
        return res.status(400).json({ error: 'Conversation ID is required' });
      }

      const { messages, total } = await messageService.getMessages(
        conversationId, userId, page, limit
      );
      sendSuccess(res, messages, 'Messages', 200, buildPaginationMeta(total, page, limit));
    } catch (err) {
      next(err);
    }
  },

  async sendMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const conversationId = getParamValue(req.params.conversationId);
      const { content, mediaUrl, thumbnailUrl, type, duration, repliedToId, forwardedFromId } = req.body;

      if (!conversationId) {
        return res.status(400).json({ error: 'Conversation ID is required' });
      }

      const message = await messageService.sendMessage(
        conversationId, userId, content, req.body.receiverId,
        { mediaUrl, thumbnailUrl, type, duration, repliedToId, forwardedFromId }
      );
      sendSuccess(res, message, 'Message sent', 201);
    } catch (err) {
      next(err);
    }
  },

  async editMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const messageId = getParamValue(req.params.messageId);
      const { content } = req.body;

      const message = await messageService.editMessage(messageId, userId, content);
      sendSuccess(res, message, 'Message edited');
    } catch (err) {
      next(err);
    }
  },

  async deleteMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const messageId = getParamValue(req.params.messageId);
      const { deleteFor } = req.body;

      const result = await messageService.deleteMessage(messageId, userId, deleteFor ?? 'me');
      sendSuccess(res, result, 'Message deleted');
    } catch (err) {
      next(err);
    }
  },

  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const conversationId = getParamValue(req.params.conversationId);

      await messageService.markMessagesRead(conversationId, userId);
      sendSuccess(res, null, 'Messages marked as read');
    } catch (err) {
      next(err);
    }
  },

  async markDelivered(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const { messageIds } = req.body;

      await messageService.markMessagesDelivered(messageIds, userId);
      sendSuccess(res, null, 'Messages marked as delivered');
    } catch (err) {
      next(err);
    }
  },

  async forwardMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const { messageId, targetConversationId } = req.body;

      const forwarded = await messageService.forwardMessage(messageId, userId, targetConversationId);
      sendSuccess(res, forwarded, 'Message forwarded', 201);
    } catch (err) {
      next(err);
    }
  },
};
