import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database.js';
import { mediaBaseUrl } from '../config/media.js';
import type { AuthRequest } from '../types/index.js';
import { ForbiddenError, NotFoundError } from '../utils/errors.js';
export async function authorizeMedia(req: Request, res: Response, next: NextFunction) {
  try {
    const key = decodeURIComponent(req.path).replace(/^\//, '');
    if (!/^(images|videos|audio)\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(key)) throw new NotFoundError('Media');
    let url = `${mediaBaseUrl()}/${key}`;
    const userId = (req as AuthRequest).user?.userId;
    const asset = await prisma.mediaAsset.findUnique({ where: { key } });
    if (asset) { res.type(asset.mimeType); url = asset.sourceUrl ?? url; }
    const [post, avatar, story] = await Promise.all([
      prisma.post.findFirst({ where: { deletedAt: null, OR: [{ imageUrls: { has: url } }, { videoUrl: url }] }, select: { id: true } }),
      prisma.user.findFirst({ where: { avatarUrl: url, deletedAt: null, accountStatus: 'ACTIVE' }, select: { id: true } }),
      userId ? prisma.story.findFirst({ where: { mediaUrl: url, deletedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }) : null,
    ]);
    if (post || avatar || story || (userId && asset?.ownerId === userId)) {
      if (!post && !avatar) res.set('Cache-Control', 'private, no-store');
      return next();
    }
    if (userId && await prisma.message.findFirst({ where: {
      deletedAt: null, deletions: { none: { userId } },
      OR: [{ mediaUrl: url }, { thumbnailUrl: url }],
      conversation: { participants: { some: { userId, deletedAt: null } } },
    }, select: { id: true } })) { res.set('Cache-Control', 'private, no-store'); return next(); }
    throw new ForbiddenError('Media access denied');
  } catch (error) { next(error); }
}
