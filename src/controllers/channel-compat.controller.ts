import type { NextFunction, Request, Response } from 'express';
import { communityService } from '../services/community.service.js';
import { messageService } from '../services/message.service.js';
import { stickerService } from '../services/sticker.service.js';
import type { AuthRequest } from '../types/index.js';
import { buildPaginationMeta, sendSuccess } from '../utils/response.js';
import { channelListQuerySchema, channelPostsQuerySchema } from '../middlewares/schemas.js';

function userId(req: Request): string {
  return (req as AuthRequest).user.userId;
}

type ChannelMessage = Awaited<ReturnType<typeof messageService.sendMessage>> | Awaited<ReturnType<typeof messageService.updateChannelPost>>;

function channelPostDto(message: ChannelMessage) {
  const author = message.sender;
  return {
    id: message.id,
    channelId: message.conversationId,
    content: message.content ?? '',
    type: message.type,
    mediaUrl: message.mediaUrl ?? null,
    thumbnailUrl: message.thumbnailUrl ?? null,
    fileName: message.fileName ?? null,
    fileMimeType: message.fileMimeType ?? null,
    fileSize: message.fileSize ?? null,
    duration: message.duration ?? null,
    pinned: message.pinned ?? false,
    createdAt: message.createdAt,
    author: author ? {
      id: author.id, username: author.username,
      displayName: author.displayName ?? null, avatarUrl: author.avatarUrl ?? null,
    } : null,
  };
}

export const channelCompatController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const query = channelListQuerySchema.parse({ query: req.query }).query;
      const result = await communityService.listChannelContract(currentUserId, query.query, query.scope, query.page, query.limit);
      sendSuccess(res, result.items, 'Channels', 200, buildPaginationMeta(result.total, result.page, result.limit));
    } catch (error) { next(error); }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const input = req.body as { name: string; description?: string | null; avatarUrl?: string | null; isPrivate: boolean };
      const created = await communityService.createChannel(currentUserId, {
        name: input.name, description: input.description, avatarUrl: input.avatarUrl, isPublic: !input.isPrivate,
      });
      const channel = await communityService.getChannelContract(created.channel.id, currentUserId);
      sendSuccess(res, { ...channel, ...(created.inviteToken ? { inviteToken: created.inviteToken } : {}) }, 'Channel created', 201);
    } catch (error) { next(error); }
  },

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await communityService.getChannelContract(req.params.id as string, userId(req)));
    } catch (error) { next(error); }
  },

  async subscribe(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const input = req.body as { inviteToken?: string };
      await communityService.joinChannel(req.params.id as string, currentUserId, input.inviteToken);
      sendSuccess(res, await communityService.getChannelContract(req.params.id as string, currentUserId), 'Channel subscribed');
    } catch (error) { next(error); }
  },

  async unsubscribe(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const channel = await communityService.getChannelContract(req.params.id as string, currentUserId);
      await communityService.leaveChannel(req.params.id as string, currentUserId);
      sendSuccess(res, {
        ...channel,
        subscriberCount: Math.max(0, channel.subscriberCount - (channel.isSubscribed ? 1 : 0)),
        isSubscribed: false, role: 'subscriber', canPost: false,
      }, 'Channel unsubscribed');
    } catch (error) { next(error); }
  },

  async listPosts(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const { query } = channelPostsQuerySchema.parse({ params: req.params, query: req.query });
      const result = await messageService.getChannelPosts(req.params.id as string, currentUserId, query.limit, query.cursor);
      const data = result.posts.map(channelPostDto);
      const meta = {
        page: 1, limit: query.limit, total: result.total,
        totalPages: Math.ceil(result.total / query.limit), hasNext: result.hasMore,
        hasPrev: !!query.cursor, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
      sendSuccess(res, data, 'Channel posts', 200, meta);
    } catch (error) { next(error); }
  },

  async createPost(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const body = req.body as {
        content?: string; type?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'STICKER';
        mediaUrl?: string | null; thumbnailUrl?: string | null; fileName?: string | null;
        fileMimeType?: string | null; fileSize?: number | null; duration?: number | null; pinned?: boolean;
      };
      let stickerId: string | undefined;
      let mediaUrl = body.mediaUrl;
      if (body.type === 'STICKER') {
        stickerId = await stickerService.resolveMessageStickerByUrl(currentUserId, body.mediaUrl!);
        mediaUrl = undefined;
      }
      const message = await messageService.sendMessage(req.params.id as string, currentUserId,
        body.type === 'STICKER' ? '' : body.content ?? '', undefined, {
          type: body.type ?? 'TEXT', mediaUrl, thumbnailUrl: body.thumbnailUrl,
          fileName: body.fileName, fileMimeType: body.fileMimeType, fileSize: body.fileSize,
          duration: body.duration, pinned: body.pinned, stickerId,
        });
      sendSuccess(res, channelPostDto(message), 'Channel post created', 201);
    } catch (error) { next(error); }
  },

  async updatePost(req: Request, res: Response, next: NextFunction) {
    try {
      const message = await messageService.updateChannelPost(req.params.id as string, req.params.postId as string,
        userId(req), req.body as { content?: string; pinned?: boolean });
      sendSuccess(res, channelPostDto(message), 'Channel post updated');
    } catch (error) { next(error); }
  },

  async deletePost(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await messageService.deleteChannelPost(req.params.id as string, req.params.postId as string, userId(req));
      sendSuccess(res, result, 'Channel post deleted');
    } catch (error) { next(error); }
  },
};
