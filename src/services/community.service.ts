import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma, ConversationRole } from '@prisma/client';
import { prisma } from '../config/database.js';
import { enqueueDomainEvent, nudgeDomainOutbox } from './domain-outbox.service.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { decodeCursor, encodeCursor, boundedLimit } from '../utils/opaque-cursor.js';

const MAX_GROUP_MEMBERS = 500;
const MAX_CHANNEL_MEMBERS = 5_000;

const memberInclude = {
  participants: {
    where: { deletedAt: null },
    include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    orderBy: [{ joinedAt: 'asc' as const }, { userId: 'asc' as const }],
  },
} satisfies Prisma.ConversationInclude;

async function activeMembers(tx: Prisma.TransactionClient, memberIds: string[]) {
  const ids = [...new Set(memberIds)];
  if (ids.length !== memberIds.length) throw new ValidationError('Member IDs must be unique');
  const found = await tx.user.findMany({ where: { id: { in: ids }, deletedAt: null, accountStatus: 'ACTIVE' }, select: { id: true } });
  if (found.length !== ids.length) throw new ValidationError('One or more members are unavailable');
  return ids;
}

async function lockConversation(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM conversations WHERE id=${id} FOR UPDATE`;
}

async function findCommunityConversation(tx: Prisma.TransactionClient, id: string, kind: 'GROUP' | 'CHANNEL') {
  const conversation = await tx.conversation.findFirst({ where: { id, kind }, include: memberInclude });
  if (!conversation) throw new NotFoundError(kind === 'GROUP' ? 'Group' : 'Channel');
  return conversation;
}

async function findChannelForMutation(tx: Prisma.TransactionClient, id: string) {
  const channel = await tx.conversation.findFirst({ where: { id, kind: 'CHANNEL' } });
  if (!channel) throw new NotFoundError('Channel');
  return channel;
}

async function activeParticipant(tx: Prisma.TransactionClient, conversationId: string, userId: string) {
  const participant = await tx.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  if (!participant || participant.deletedAt) throw new ForbiddenError('Not an active member');
  return participant;
}

function requireActiveMember(conversation: { participants: Array<{ userId: string; role: ConversationRole }> }, userId: string) {
  const member = conversation.participants.find(participant => participant.userId === userId);
  if (!member) throw new ForbiddenError('Not an active member');
  return member;
}

function requireAdmin(member: { role: ConversationRole }) {
  if (member.role !== 'ADMIN') throw new ForbiddenError('Administrator permission required');
}

async function recordMembership(tx: Prisma.TransactionClient, conversationId: string, kind: 'GROUP' | 'CHANNEL', action: string, actorId: string, memberIds: string[]) {
  await enqueueDomainEvent(tx, 'conversationMembership', {
    eventId: randomUUID(), conversationId, kind, action, actorId,
    memberIds: [...new Set(memberIds)], occurredAt: new Date().toISOString(),
  });
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function inviteMatches(storedHash: string | null, token: string | undefined): boolean {
  if (!storedHash || !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const provided = Buffer.from(tokenHash(token), 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

async function channelMemberCounts(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await prisma.conversationParticipant.groupBy({
    by: ['conversationId'], where: { conversationId: { in: ids }, deletedAt: null }, _count: { _all: true },
  });
  return new Map(rows.map(row => [row.conversationId, row._count._all]));
}

export const communityService = {
  async createGroup(ownerId: string, input: { name: string; description?: string; memberIds: string[] }) {
    const memberIds = [...new Set(input.memberIds)];
    if (memberIds.length !== input.memberIds.length || memberIds.includes(ownerId)) throw new ValidationError('Member IDs must be unique and cannot include the creator');
    if (memberIds.length + 1 > MAX_GROUP_MEMBERS) throw new ValidationError(`Groups are limited to ${MAX_GROUP_MEMBERS} active members`);
    const group = await prisma.$transaction(async tx => {
      await activeMembers(tx, [ownerId, ...memberIds]);
      const created = await tx.conversation.create({ data: {
        isGroup: true, kind: 'GROUP', groupName: input.name, description: input.description ?? null, ownerId,
        participants: { create: [{ userId: ownerId, role: 'ADMIN' }, ...memberIds.map(userId => ({ userId, role: 'MEMBER' as const }))] },
      }, include: memberInclude });
      await recordMembership(tx, created.id, 'GROUP', 'created', ownerId, [ownerId, ...memberIds]);
      return created;
    });
    void nudgeDomainOutbox();
    return group;
  },

  async listGroups(userId: string, limitInput?: unknown, cursorInput?: string) {
    const limit = boundedLimit(limitInput);
    const cursor = decodeCursor(cursorInput);
    const where: Prisma.ConversationWhereInput = { kind: 'GROUP', participants: { some: { userId, deletedAt: null } },
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) };
    const rows = await prisma.conversation.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      select: { id: true, kind: true, groupName: true, description: true, ownerId: true, createdAt: true, updatedAt: true } });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const counts = await channelMemberCounts(items.map(group => group.id));
    return { items: items.map(group => ({ ...group, memberCount: counts.get(group.id) ?? 0 })),
      nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!.createdAt, items[items.length - 1]!.id) : null,
      hasMore };
  },

  async getGroup(conversationId: string, userId: string) {
    const group = await prisma.conversation.findFirst({ where: { id: conversationId, kind: 'GROUP' }, include: memberInclude });
    if (!group) throw new NotFoundError('Group');
    requireActiveMember(group, userId);
    return group;
  },

  async updateGroup(conversationId: string, actorId: string, input: { name?: string; description?: string | null }) {
    const updated = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const group = await findCommunityConversation(tx, conversationId, 'GROUP');
      requireAdmin(requireActiveMember(group, actorId));
      const result = await tx.conversation.update({ where: { id: conversationId }, data: {
        ...(input.name !== undefined ? { groupName: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      }, include: memberInclude });
      await recordMembership(tx, conversationId, 'GROUP', 'updated', actorId, [actorId]);
      return result;
    });
    void nudgeDomainOutbox();
    return updated;
  },

  async addGroupMembers(conversationId: string, actorId: string, memberIds: string[]) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const group = await findCommunityConversation(tx, conversationId, 'GROUP');
      requireAdmin(requireActiveMember(group, actorId));
      const ids = await activeMembers(tx, memberIds);
      const projectedSize = new Set([...group.participants.map(participant => participant.userId), ...ids]).size;
      if (projectedSize > MAX_GROUP_MEMBERS) throw new ValidationError(`Groups are limited to ${MAX_GROUP_MEMBERS} active members`);
      const added: string[] = [];
      for (const userId of ids) {
        if (userId === group.ownerId) continue;
        const existing = await tx.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
        if (existing?.deletedAt) {
          await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: { deletedAt: null, joinedAt: new Date(), role: 'MEMBER' } });
          added.push(userId);
        } else if (!existing) {
          await tx.conversationParticipant.create({ data: { conversationId, userId, role: 'MEMBER' } });
          added.push(userId);
        }
      }
      if (added.length) await recordMembership(tx, conversationId, 'GROUP', 'members-added', actorId, added);
      return { conversationId, addedMemberIds: added };
    });
    if (result.addedMemberIds.length) void nudgeDomainOutbox();
    return result;
  },

  async removeGroupMember(conversationId: string, actorId: string, memberId: string) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const group = await findCommunityConversation(tx, conversationId, 'GROUP');
      const actor = requireActiveMember(group, actorId);
      const target = group.participants.find(participant => participant.userId === memberId);
      if (!target) throw new NotFoundError('Group member');
      if (memberId !== actorId) {
        requireAdmin(actor);
        if (target.role === 'ADMIN' && group.ownerId !== actorId) throw new ForbiddenError('Only the group owner can remove an administrator');
      }
      if (memberId === group.ownerId) throw new ForbiddenError('The group owner cannot leave or be removed');
      if (target.role === 'ADMIN') {
        const admins = group.participants.filter(participant => participant.role === 'ADMIN');
        if (admins.length <= 1) throw new ValidationError('A group must retain at least one administrator');
      }
      const deletedAt = new Date();
      await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId: memberId } }, data: { deletedAt } });
      await recordMembership(tx, conversationId, 'GROUP', 'member-removed', actorId, [memberId]);
      return { conversationId, userId: memberId, deletedAt: deletedAt.toISOString() };
    });
    void nudgeDomainOutbox();
    return result;
  },

  async setGroupRole(conversationId: string, actorId: string, memberId: string, role: ConversationRole) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const group = await findCommunityConversation(tx, conversationId, 'GROUP');
      requireActiveMember(group, actorId);
      if (group.ownerId !== actorId) throw new ForbiddenError('Only the group owner can change administrator roles');
      const target = group.participants.find(participant => participant.userId === memberId);
      if (!target) throw new NotFoundError('Group member');
      if (memberId === group.ownerId && role !== 'ADMIN') throw new ValidationError('The group owner must remain an administrator');
      if (target.role === 'ADMIN' && role === 'MEMBER' && group.participants.filter(p => p.role === 'ADMIN').length <= 1) {
        throw new ValidationError('A group must retain at least one administrator');
      }
      await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId: memberId } }, data: { role } });
      await recordMembership(tx, conversationId, 'GROUP', 'role-changed', actorId, [memberId]);
      return { conversationId, userId: memberId, role };
    });
    void nudgeDomainOutbox();
    return result;
  },

  async createChannel(ownerId: string, input: { name: string; description?: string; isPublic: boolean; slug?: string }) {
    if (input.isPublic && !input.slug) throw new ValidationError('Public channels require a slug');
    const inviteToken = input.isPublic ? undefined : randomBytes(32).toString('base64url');
    const channel = await prisma.$transaction(async tx => {
      await activeMembers(tx, [ownerId]);
      const created = await tx.conversation.create({ data: {
        isGroup: true, kind: 'CHANNEL', groupName: input.name, description: input.description ?? null,
        ownerId, isPublic: input.isPublic, slug: input.slug ?? null,
        inviteTokenHash: inviteToken ? tokenHash(inviteToken) : null,
        participants: { create: { userId: ownerId, role: 'ADMIN' } },
      }, include: memberInclude });
      await recordMembership(tx, created.id, 'CHANNEL', 'created', ownerId, [ownerId]);
      return created;
    });
    void nudgeDomainOutbox();
    const { inviteTokenHash: _inviteTokenHash, ...safeChannel } = channel;
    return { channel: safeChannel, ...(inviteToken ? { inviteToken } : {}) };
  },

  async listPublicChannels(limitInput?: unknown, cursorInput?: string) {
    const limit = boundedLimit(limitInput);
    const cursor = decodeCursor(cursorInput);
    const where: Prisma.ConversationWhereInput = { kind: 'CHANNEL', isPublic: true,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) };
    const rows = await prisma.conversation.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      select: { id: true, kind: true, groupName: true, description: true, slug: true, createdAt: true, ownerId: true } });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const counts = await channelMemberCounts(items.map(channel => channel.id));
    return { items: items.map(channel => ({ ...channel, memberCount: counts.get(channel.id) ?? 0 })),
      nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!.createdAt, items[items.length - 1]!.id) : null,
      hasMore };
  },

  async getChannel(conversationId: string, userId: string) {
    const channel = await prisma.conversation.findFirst({ where: { id: conversationId, kind: 'CHANNEL' }, select: {
      id: true, kind: true, groupName: true, description: true, ownerId: true, isPublic: true, slug: true, createdAt: true, updatedAt: true,
      participants: { where: { userId, deletedAt: null }, select: { role: true } },
    } });
    if (!channel) throw new NotFoundError('Channel');
    const isMember = channel.participants.length > 0;
    if (!channel.isPublic && !isMember) throw new NotFoundError('Channel');
    return { id: channel.id, kind: channel.kind, groupName: channel.groupName, description: channel.description,
      ownerId: channel.ownerId, isPublic: channel.isPublic, slug: channel.slug, createdAt: channel.createdAt,
      updatedAt: channel.updatedAt, memberCount: (await channelMemberCounts([conversationId])).get(conversationId) ?? 0,
      isMember, role: channel.participants[0]?.role ?? null };
  },

  async updateChannel(conversationId: string, actorId: string, input: { name?: string; description?: string | null; isPublic?: boolean; slug?: string | null }) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const channel = await findChannelForMutation(tx, conversationId);
      await activeParticipant(tx, conversationId, actorId);
      if (channel.ownerId !== actorId) throw new ForbiddenError('Only the channel owner can update channel settings');
      const nextPublic = input.isPublic ?? channel.isPublic;
      const nextSlug = input.slug !== undefined ? input.slug : channel.slug;
      if (nextPublic && !nextSlug) throw new ValidationError('Public channels require a slug');
      const updated = await tx.conversation.update({ where: { id: conversationId }, data: {
        ...(input.name !== undefined ? { groupName: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.isPublic !== undefined && input.isPublic !== channel.isPublic ? { inviteTokenHash: null } : {}),
      } });
      await recordMembership(tx, conversationId, 'CHANNEL', 'updated', actorId, [actorId]);
      return updated;
    });
    void nudgeDomainOutbox();
    const { inviteTokenHash: _inviteTokenHash, ...safeChannel } = result;
    return safeChannel;
  },

  async joinChannel(conversationId: string, userId: string, inviteToken?: string) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const channel = await findChannelForMutation(tx, conversationId);
      const existing = await tx.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
      if (existing && !existing.deletedAt) return { conversationId, joined: false };
      if (!channel.isPublic && !inviteMatches(channel.inviteTokenHash, inviteToken)) throw new NotFoundError('Channel invite');
      await activeMembers(tx, [userId]);
      const memberCount = await tx.conversationParticipant.count({ where: { conversationId, deletedAt: null } });
      if (memberCount >= MAX_CHANNEL_MEMBERS) throw new ValidationError(`Channels are limited to ${MAX_CHANNEL_MEMBERS} active members`);
      if (existing) await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: {
        deletedAt: null, joinedAt: new Date(), role: channel.ownerId === userId ? 'ADMIN' : 'MEMBER',
      } });
      else await tx.conversationParticipant.create({ data: { conversationId, userId, role: 'MEMBER' } });
      await recordMembership(tx, conversationId, 'CHANNEL', 'member-joined', userId, [userId]);
      return { conversationId, joined: true };
    });
    if (result.joined) void nudgeDomainOutbox();
    return result;
  },

  async leaveChannel(conversationId: string, userId: string) {
    return this.removeChannelMember(conversationId, userId, userId);
  },

  async removeChannelMember(conversationId: string, actorId: string, memberId: string) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const channel = await findChannelForMutation(tx, conversationId);
      const actor = await activeParticipant(tx, conversationId, actorId);
      const target = await activeParticipant(tx, conversationId, memberId);
      if (memberId !== actorId) {
        requireAdmin(actor);
        if (target.role === 'ADMIN' && channel.ownerId !== actorId) throw new ForbiddenError('Only the channel owner can remove an administrator');
      }
      if (memberId === channel.ownerId) throw new ForbiddenError('The channel owner cannot leave or be removed');
      const deletedAt = new Date();
      await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId: memberId } }, data: { deletedAt } });
      await recordMembership(tx, conversationId, 'CHANNEL', 'member-removed', actorId, [memberId]);
      return { conversationId, userId: memberId, deletedAt: deletedAt.toISOString() };
    });
    void nudgeDomainOutbox();
    return result;
  },

  async setChannelRole(conversationId: string, actorId: string, memberId: string, role: ConversationRole) {
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const channel = await findChannelForMutation(tx, conversationId);
      await activeParticipant(tx, conversationId, actorId);
      if (channel.ownerId !== actorId) throw new ForbiddenError('Only the channel owner can change administrator roles');
      await activeParticipant(tx, conversationId, memberId);
      if (memberId === channel.ownerId && role !== 'ADMIN') throw new ValidationError('The channel owner must remain an administrator');
      await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId: memberId } }, data: { role } });
      await recordMembership(tx, conversationId, 'CHANNEL', 'role-changed', actorId, [memberId]);
      return { conversationId, userId: memberId, role };
    });
    void nudgeDomainOutbox();
    return result;
  },

  async rotateChannelInvite(conversationId: string, actorId: string) {
    const inviteToken = randomBytes(32).toString('base64url');
    const result = await prisma.$transaction(async tx => {
      await lockConversation(tx, conversationId);
      const channel = await findChannelForMutation(tx, conversationId);
      await activeParticipant(tx, conversationId, actorId);
      if (channel.ownerId !== actorId) throw new ForbiddenError('Only the channel owner can rotate invites');
      if (channel.isPublic) throw new ValidationError('Public channels do not use invite tokens');
      const updated = await tx.conversation.update({ where: { id: conversationId }, data: { inviteTokenHash: tokenHash(inviteToken) } });
      await recordMembership(tx, conversationId, 'CHANNEL', 'invite-rotated', actorId, [actorId]);
      return updated;
    });
    void nudgeDomainOutbox();
    return { channelId: result.id, inviteToken };
  },
};
