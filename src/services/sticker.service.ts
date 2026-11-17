import { randomUUID } from 'node:crypto';
import type { Prisma, StickerPack } from '@prisma/client';
import { prisma } from '../config/database.js';
import { enqueueDomainEvent, nudgeDomainOutbox } from './domain-outbox.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { boundedLimit, decodeCursor, encodeCursor } from '../utils/opaque-cursor.js';

const stickerInclude = {
  asset: { select: { id: true, url: true, mimeType: true, size: true } },
} satisfies Prisma.StickerInclude;

function visiblePackFilter(userId: string): Prisma.StickerPackWhereInput {
  return { OR: [{ isPublic: true }, { ownerId: userId }, { installs: { some: { userId } } }] };
}

function accessibleStickerFilter(userId: string): Prisma.StickerWhereInput {
  return { pack: { OR: [{ isPublic: true }, { ownerId: userId }, { installs: { some: { userId } } }] } };
}

function packSummary<T extends StickerPack>(pack: T) { return pack; }

async function ensureStickerAccessible(stickerId: string, userId: string, tx: Prisma.TransactionClient = prisma) {
  const sticker = await tx.sticker.findFirst({ where: { id: stickerId, ...accessibleStickerFilter(userId) }, include: { ...stickerInclude, pack: { select: { id: true, title: true, shortName: true } } } });
  if (!sticker) throw new NotFoundError('Sticker');
  return sticker;
}

export const stickerService = {
  async createPack(ownerId: string, input: { shortName: string; title: string; description?: string; isPublic: boolean; stickers: Array<{ mediaUrl: string; emoji?: string }> }) {
    const urls = input.stickers.map(sticker => sticker.mediaUrl);
    if (new Set(urls).size !== urls.length) throw new ValidationError('A sticker asset may only be used once in a pack');
    const result = await prisma.$transaction(async tx => {
      const assets = await tx.mediaAsset.findMany({ where: { ownerId, url: { in: urls } }, select: { id: true, url: true, mimeType: true, size: true } });
      if (assets.length !== urls.length) throw new ValidationError('Sticker files must be uploaded by the current account');
      const byUrl = new Map(assets.map(asset => [asset.url, asset]));
      let totalBytes = 0;
      const stickerRows = input.stickers.map((item, position) => {
        const asset = byUrl.get(item.mediaUrl)!;
        if (!asset.mimeType.startsWith('image/') || asset.size <= 0 || asset.size > 512 * 1024) {
          throw new ValidationError('Stickers must be owned images no larger than 512 KB');
        }
        totalBytes += asset.size;
        return { mediaAssetId: asset.id, position, emoji: item.emoji ?? null };
      });
      if (totalBytes > 10 * 1024 * 1024) throw new ValidationError('Sticker pack assets exceed the 10 MB limit');
      const pack = await tx.stickerPack.create({ data: {
        ownerId, shortName: input.shortName, title: input.title, description: input.description ?? null, isPublic: input.isPublic,
        stickers: { create: stickerRows },
      }, include: { stickers: { include: stickerInclude, orderBy: { position: 'asc' } } } });
      await enqueueDomainEvent(tx, 'stickerPackChanged', { eventId: randomUUID(), action: 'created', packId: pack.id, actorId: ownerId, isPublic: pack.isPublic });
      return pack;
    });
    void nudgeDomainOutbox();
    return result;
  },

  async listPacks(userId: string, limitInput?: unknown, cursorInput?: string) {
    const limit = boundedLimit(limitInput);
    const cursor = decodeCursor(cursorInput);
    const where: Prisma.StickerPackWhereInput = { AND: [visiblePackFilter(userId),
      ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] : [])] };
    const rows = await prisma.stickerPack.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      include: { owner: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        stickers: { take: 4, orderBy: { position: 'asc' }, include: stickerInclude },
        installs: { where: { userId }, select: { installedAt: true }, take: 1 } } });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(pack => ({ ...packSummary(pack), installed: pack.installs.length > 0, installs: undefined }));
    return { items, nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!.createdAt, items[items.length - 1]!.id) : null, hasMore };
  },

  async getPack(userId: string, packId: string) {
    const pack = await prisma.stickerPack.findFirst({ where: { id: packId, ...visiblePackFilter(userId) }, include: {
      owner: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      stickers: { orderBy: { position: 'asc' }, include: stickerInclude },
      installs: { where: { userId }, select: { installedAt: true }, take: 1 },
    } });
    if (!pack) throw new NotFoundError('Sticker pack');
    const { installs, ...details } = pack;
    return { ...details, installed: installs.length > 0 };
  },

  async installPack(userId: string, packId: string) {
    const result = await prisma.$transaction(async tx => {
      const pack = await tx.stickerPack.findFirst({ where: { id: packId, OR: [{ isPublic: true }, { ownerId: userId }] }, select: { id: true, isPublic: true } });
      if (!pack) throw new NotFoundError('Sticker pack');
      const created = await tx.stickerPackInstall.createMany({ data: [{ userId, packId }], skipDuplicates: true });
      if (created.count) await enqueueDomainEvent(tx, 'stickerPackChanged', { eventId: randomUUID(), action: 'installed', packId, actorId: userId });
      return { packId, installed: true, alreadyInstalled: created.count === 0 };
    });
    if (!result.alreadyInstalled) void nudgeDomainOutbox();
    return result;
  },

  async uninstallPack(userId: string, packId: string) {
    const result = await prisma.$transaction(async tx => {
      const removed = await tx.stickerPackInstall.deleteMany({ where: { userId, packId } });
      if (removed.count) await enqueueDomainEvent(tx, 'stickerPackChanged', { eventId: randomUUID(), action: 'uninstalled', packId, actorId: userId });
      return { packId, installed: false };
    });
    void nudgeDomainOutbox();
    return result;
  },

  async favorite(userId: string, stickerId: string) {
    const result = await prisma.$transaction(async tx => {
      const sticker = await ensureStickerAccessible(stickerId, userId, tx);
      const created = await tx.stickerFavorite.createMany({ data: [{ userId, stickerId }], skipDuplicates: true });
      if (created.count) await enqueueDomainEvent(tx, 'stickerPackChanged', { eventId: randomUUID(), action: 'favorited', packId: sticker.packId, stickerId, actorId: userId });
      return { stickerId, favorite: true, alreadyFavorite: created.count === 0 };
    });
    if (!result.alreadyFavorite) void nudgeDomainOutbox();
    return result;
  },

  async unfavorite(userId: string, stickerId: string) {
    const result = await prisma.$transaction(async tx => {
      const removed = await tx.stickerFavorite.deleteMany({ where: { userId, stickerId } });
      if (removed.count) await enqueueDomainEvent(tx, 'stickerPackChanged', { eventId: randomUUID(), action: 'unfavorited', stickerId, actorId: userId });
      return { stickerId, favorite: false };
    });
    void nudgeDomainOutbox();
    return result;
  },

  async listFavorites(userId: string, limitInput?: unknown, cursorInput?: string) {
    const limit = boundedLimit(limitInput);
    const cursor = decodeCursor(cursorInput);
    const rows = await prisma.stickerFavorite.findMany({ where: { userId,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, stickerId: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { stickerId: 'desc' }], take: limit + 1,
      include: { sticker: { include: { ...stickerInclude, pack: { select: { id: true, shortName: true, title: true, isPublic: true } } } } } });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(row => ({ ...row.sticker, favoritedAt: row.createdAt }));
    return { items, nextCursor: hasMore && rows.length > limit ? encodeCursor(rows[limit - 1]!.createdAt, rows[limit - 1]!.stickerId) : null, hasMore };
  },

  async listRecents(userId: string, limitInput?: unknown, cursorInput?: string) {
    const limit = boundedLimit(limitInput);
    const cursor = decodeCursor(cursorInput);
    const rows = await prisma.stickerRecent.findMany({ where: { userId,
      ...(cursor ? { OR: [{ usedAt: { lt: cursor.createdAt } }, { usedAt: cursor.createdAt, stickerId: { lt: cursor.id } }] } : {}) },
      orderBy: [{ usedAt: 'desc' }, { stickerId: 'desc' }], take: limit + 1,
      include: { sticker: { include: { ...stickerInclude, pack: { select: { id: true, shortName: true, title: true } } } } } });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(row => ({ ...row.sticker, usedAt: row.usedAt }));
    return { items, nextCursor: hasMore && rows.length > limit ? encodeCursor(rows[limit - 1]!.usedAt, rows[limit - 1]!.stickerId) : null, hasMore };
  },

  async recordRecent(tx: Prisma.TransactionClient, userId: string, stickerId: string) {
    await tx.stickerRecent.upsert({ where: { userId_stickerId: { userId, stickerId } },
      create: { userId, stickerId }, update: { usedAt: new Date() } });
  },

  async resolveMessageSticker(tx: Prisma.TransactionClient, userId: string, stickerId: string) {
    return ensureStickerAccessible(stickerId, userId, tx);
  },
};
