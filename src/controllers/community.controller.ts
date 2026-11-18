import type { NextFunction, Request, Response } from 'express';
import { communityService } from '../services/community.service.js';
import { AuthRequest } from '../types/index.js';
import { sendSuccess } from '../utils/response.js';

export const communityController = {
  async createGroup(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.createGroup((req as AuthRequest).user.userId, req.body), 'Group created', 201); }
    catch (error) { next(error); }
  },
  async listGroups(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.listGroups((req as AuthRequest).user.userId, req.query.limit, req.query.cursor as string | undefined)); }
    catch (error) { next(error); }
  },
  async getGroup(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.getGroup(req.params.conversationId as string, (req as AuthRequest).user.userId)); }
    catch (error) { next(error); }
  },
  async updateGroup(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.updateGroup(req.params.conversationId as string, (req as AuthRequest).user.userId, req.body), 'Group updated'); }
    catch (error) { next(error); }
  },
  async addGroupMembers(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.addGroupMembers(req.params.conversationId as string, (req as AuthRequest).user.userId, req.body.memberIds), 'Group members updated'); }
    catch (error) { next(error); }
  },
  async removeGroupMember(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.removeGroupMember(req.params.conversationId as string, (req as AuthRequest).user.userId, req.params.memberId as string), 'Group member removed'); }
    catch (error) { next(error); }
  },
  async setGroupRole(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.setGroupRole(req.params.conversationId as string, (req as AuthRequest).user.userId, req.params.memberId as string, req.body.role), 'Group role updated'); }
    catch (error) { next(error); }
  },
  async createChannel(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.createChannel((req as AuthRequest).user.userId, req.body), 'Channel created', 201); }
    catch (error) { next(error); }
  },
  async listChannels(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.listPublicChannels(req.query.limit, req.query.cursor as string | undefined)); }
    catch (error) { next(error); }
  },
  async getChannel(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.getChannel(req.params.conversationId as string, (req as AuthRequest).user.userId)); }
    catch (error) { next(error); }
  },
  async updateChannel(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.updateChannel(req.params.conversationId as string, (req as AuthRequest).user.userId, req.body), 'Channel updated'); }
    catch (error) { next(error); }
  },
  async joinChannel(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.joinChannel(req.params.conversationId as string, (req as AuthRequest).user.userId, req.body.inviteToken), 'Channel membership updated'); }
    catch (error) { next(error); }
  },
  async leaveChannel(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.leaveChannel(req.params.conversationId as string, (req as AuthRequest).user.userId), 'Channel left'); }
    catch (error) { next(error); }
  },
  async removeChannelMember(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.removeChannelMember(req.params.conversationId as string, (req as AuthRequest).user.userId, req.params.memberId as string), 'Channel member removed'); }
    catch (error) { next(error); }
  },
  async setChannelRole(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.setChannelRole(req.params.conversationId as string, (req as AuthRequest).user.userId, req.params.memberId as string, req.body.role), 'Channel role updated'); }
    catch (error) { next(error); }
  },
  async rotateChannelInvite(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await communityService.rotateChannelInvite(req.params.conversationId as string, (req as AuthRequest).user.userId), 'Channel invite rotated'); }
    catch (error) { next(error); }
  },
};
