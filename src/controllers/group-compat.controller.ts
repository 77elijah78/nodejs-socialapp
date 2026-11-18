import type { NextFunction, Request, Response } from 'express';
import type { ConversationRole } from '@prisma/client';
import { communityService } from '../services/community.service.js';
import type { AuthRequest } from '../types/index.js';
import { sendSuccess } from '../utils/response.js';

type GroupRecord = {
  id: string;
  groupName: string | null;
  groupAvatar: string | null;
  description: string | null;
  ownerId: string | null;
  createdAt: Date;
  participants: Array<{
    userId: string;
    role: ConversationRole;
    joinedAt: Date;
    user: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
  }>;
};

function serializeGroup(group: GroupRecord, currentUserId: string) {
  const members = group.participants.map(participant => ({
    userId: participant.userId,
    username: participant.user.username,
    displayName: participant.user.displayName,
    avatarUrl: participant.user.avatarUrl,
    role: participant.userId === group.ownerId ? 'owner' as const : participant.role === 'ADMIN' ? 'admin' as const : 'member' as const,
    joinedAt: participant.joinedAt,
  }));
  const me = members.find(member => member.userId === currentUserId);
  const myRole = me?.role ?? 'member';
  return {
    id: group.id,
    name: group.groupName ?? 'Group',
    avatarUrl: group.groupAvatar,
    description: group.description,
    memberCount: members.length,
    members,
    myRole,
    canManage: myRole === 'owner' || myRole === 'admin',
    managementAvailable: true,
    createdAt: group.createdAt,
  };
}

function userId(req: Request): string {
  return (req as AuthRequest).user.userId;
}

export const groupCompatController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const ownerId = userId(req);
      const group = await communityService.createGroup(ownerId, req.body);
      sendSuccess(res, serializeGroup(group, ownerId), 'Group created', 201);
    } catch (error) { next(error); }
  },

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const group = await communityService.getGroup(req.params.id as string, currentUserId);
      sendSuccess(res, serializeGroup(group, currentUserId));
    } catch (error) { next(error); }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const group = await communityService.updateGroup(req.params.id as string, currentUserId, req.body);
      sendSuccess(res, serializeGroup(group, currentUserId), 'Group updated');
    } catch (error) { next(error); }
  },

  async addMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const input = req.body as { userIds: string[] };
      await communityService.addGroupMembers(req.params.id as string, currentUserId, input.userIds);
      const group = await communityService.getGroup(req.params.id as string, currentUserId);
      sendSuccess(res, serializeGroup(group, currentUserId), 'Group members updated');
    } catch (error) { next(error); }
  },

  async removeMember(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await communityService.removeGroupMember(req.params.id as string, userId(req), req.params.userId as string);
      sendSuccess(res, result, 'Group member removed');
    } catch (error) { next(error); }
  },

  async setRole(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const requestedRole = (req.body as { role: 'admin' | 'member' }).role;
      await communityService.setGroupRole(req.params.id as string, currentUserId, req.params.userId as string,
        requestedRole === 'admin' ? 'ADMIN' : 'MEMBER');
      const group = await communityService.getGroup(req.params.id as string, currentUserId);
      sendSuccess(res, serializeGroup(group, currentUserId), 'Group role updated');
    } catch (error) { next(error); }
  },

  async leave(req: Request, res: Response, next: NextFunction) {
    try {
      const currentUserId = userId(req);
      const result = await communityService.removeGroupMember(req.params.id as string, currentUserId, currentUserId);
      sendSuccess(res, result, 'Group left');
    } catch (error) { next(error); }
  },
};
