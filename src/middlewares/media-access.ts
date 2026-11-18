import { visiblePosts } from '../services/post.dto.js';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database.js';
import { canonicalUploadUrl, extractUploadMediaKey, isSharedMediaUrl } from '../config/media.js';
import type { AuthRequest } from '../types/index.js';
import { ForbiddenError, NotFoundError } from '../utils/errors.js';

function requestMediaKey(req: Request): string | null {
  let rawPath = (req.originalUrl || req.path).split(/[?#]/, 1)[0] ?? '';
  const mount = req.baseUrl;
  if (mount && rawPath.startsWith(`${mount}/`)) rawPath = rawPath.slice(mount.length);
  else if (rawPath.startsWith('/uploads/')) rawPath = rawPath.slice('/uploads'.length);
  if (!rawPath.startsWith('/') || rawPath.includes('%') || rawPath.includes('\\')) return null;
  const key = rawPath.slice(1);
  return /^(images|videos|audio)\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(key) ? key : null;
}

function addSafeCandidate(candidates: Set<string>, value: string | null | undefined) {
  if (value && isSharedMediaUrl(value)) candidates.add(value);
}

export async function authorizeMedia(req: Request, res: Response, next: NextFunction) {
  try {
    const key = requestMediaKey(req);
    if (!key) throw new NotFoundError('Media');
    const userId = (req as AuthRequest).user?.userId;
    const sourceAsset = await prisma.mediaAsset.findUnique({ where: { key }, select: {
      id: true, key: true, url: true, sourceUrl: true, ownerId: true, mimeType: true,
    } });
    if (sourceAsset) res.type(sourceAsset.mimeType);

    // Match only the canonical deployment URL and known MediaAsset URLs. This
    // resolves old/public-origin differences without treating arbitrary URLs
    // with a colliding path as references to someone else's private upload.
    const candidates = new Set<string>();
    addSafeCandidate(candidates, canonicalUploadUrl(key));
    if (sourceAsset && extractUploadMediaKey(sourceAsset.url) === sourceAsset.key) addSafeCandidate(candidates, sourceAsset.url);
    addSafeCandidate(candidates, sourceAsset?.sourceUrl);
    if (sourceAsset?.sourceUrl) {
      const parentKey = extractUploadMediaKey(sourceAsset.sourceUrl);
      if (parentKey) {
        const parentAsset = await prisma.mediaAsset.findUnique({ where: { key: parentKey }, select: { key: true, url: true } });
        addSafeCandidate(candidates, canonicalUploadUrl(parentKey));
        if (parentAsset && extractUploadMediaKey(parentAsset.url) === parentAsset.key) addSafeCandidate(candidates, parentAsset.url);
      }
    }
    const referenceUrls = [...candidates];
    const [post, avatar, story, sticker] = await Promise.all([
      prisma.post.findFirst({ where: { ...visiblePosts(userId), OR: [
        { imageUrls: { hasSome: referenceUrls } }, { videoUrl: { in: referenceUrls } },
      ] }, select: { id: true } }),
      prisma.user.findFirst({ where: { avatarUrl: { in: referenceUrls }, deletedAt: null, accountStatus: 'ACTIVE' }, select: { id: true } }),
      userId ? prisma.story.findFirst({ where: { mediaUrl: { in: referenceUrls }, deletedAt: null, expiresAt: { gt: new Date() },
        user: { deletedAt: null, accountStatus: 'ACTIVE', OR: [{ isPrivate: false }, { id: userId }] } }, select: { id: true } }) : null,
      sourceAsset ? prisma.sticker.findFirst({ where: { mediaAssetId: sourceAsset.id, OR: [
        { pack: { isPublic: true } },
        ...(userId ? [
          { pack: { ownerId: userId } },
          { pack: { installs: { some: { userId } } } },
          { messages: { some: { deletedAt: null, deletions: { none: { userId } }, conversation: { participants: { some: { userId, deletedAt: null } } } } } },
        ] : []),
      ] }, select: { id: true } }) : null,
    ]);
    if (post || avatar || story || sticker || (userId && sourceAsset?.ownerId === userId)) {
      // Visibility can change after an earlier public response; do not cache protected media.
      res.set('Cache-Control', 'private, no-store');
      return next();
    }
    if (userId && await prisma.message.findFirst({ where: {
      deletedAt: null, deletions: { none: { userId } },
      OR: [{ mediaUrl: { in: referenceUrls } }, { thumbnailUrl: { in: referenceUrls } }],
      conversation: { participants: { some: { userId, deletedAt: null } } },
    }, select: { id: true } })) { res.set('Cache-Control', 'private, no-store'); return next(); }
    throw new ForbiddenError('Media access denied');
  } catch (error) { next(error); }
}
