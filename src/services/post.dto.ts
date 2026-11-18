import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { normalizeStoredMediaReferences } from './media-url.service.js';

// No approved-follow model exists: private accounts fail closed to owner only.
export function visiblePosts(userId?: string): Prisma.PostWhereInput {
  return { deletedAt: null, author: { deletedAt: null, accountStatus: 'ACTIVE',
    OR: [{ isPrivate: false }, ...(userId ? [{ id: userId }] : [])] } };
}
export const postSelect = {
  id: true, content: true, imageUrls: true, mediaMetadata: true, videoUrl: true, createdAt: true, updatedAt: true,
  author: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } },
  _count: { select: { likes: true, comments: { where: { deletedAt: null } } } }, shareCount: true,
} satisfies Prisma.PostSelect;
export const commentSelect = {
  id: true, postId: true, authorId: true, content: true, createdAt: true, repliedToId: true,
  author: { select: { id: true, username: true, avatarUrl: true } },
  _count: { select: { likes: true, replies: { where: { deletedAt: null } } } },
} satisfies Prisma.CommentSelect;
type PostMediaProjection = {
  imageUrls?: unknown;
  videoUrl?: unknown;
  mediaMetadata?: unknown;
  author?: unknown;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function metadataUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => isRecord(item)
    ? ['url', 'thumbnailUrl'].flatMap(key => typeof item[key] === 'string' ? [item[key]] : [])
    : []);
}
function normalizeMetadata(value: unknown, replacements: Map<string, string | null>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => {
    if (!isRecord(item)) return item;
    const normalized = { ...item };
    for (const key of ['url', 'thumbnailUrl']) {
      if (typeof normalized[key] === 'string') normalized[key] = replacements.get(normalized[key]) ?? null;
    }
    return normalized;
  });
}

export async function enrichPosts<T extends { id: string; _count: { likes: number; comments: number } }>(posts: T[], userId?: string) {
  const ids = posts.map(p => p.id);
  const [likes, saved] = userId && ids.length ? await Promise.all([
    prisma.like.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
    prisma.savedPost.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
  ]) : [[], []];
  const liked = new Set(likes.map(l => l.postId)), bookmarks = new Set(saved.map(s => s.postId));
  const projections = posts as Array<T & PostMediaProjection>;
  const sourceUrls = projections.flatMap(post => [
    ...(Array.isArray(post.imageUrls) ? post.imageUrls.filter((url): url is string => typeof url === 'string') : []),
    ...(typeof post.videoUrl === 'string' ? [post.videoUrl] : []),
    ...(isRecord(post.author) && typeof post.author.avatarUrl === 'string' ? [post.author.avatarUrl] : []),
    ...metadataUrls(post.mediaMetadata),
  ]);
  const normalized = await normalizeStoredMediaReferences(sourceUrls);
  const replacements = new Map<string, string | null>();
  sourceUrls.forEach((url, index) => replacements.set(url, normalized.values[index] ?? null));
  return projections.map(post => {
    const imageUrls = Array.isArray(post.imageUrls)
      ? post.imageUrls.map(url => typeof url === 'string' ? replacements.get(url) ?? null : null).filter((url): url is string => !!url)
      : undefined;
    const videoUrl = typeof post.videoUrl === 'string' ? replacements.get(post.videoUrl) ?? null : post.videoUrl;
    const author = isRecord(post.author) && typeof post.author.avatarUrl === 'string'
      ? { ...post.author, avatarUrl: replacements.get(post.author.avatarUrl) ?? null }
      : post.author;
    return {
      ...post,
      ...(Array.isArray(post.imageUrls) ? { imageUrls } : {}),
      ...(post.videoUrl !== undefined ? { videoUrl } : {}),
      ...(post.author !== undefined ? { author } : {}),
      ...(post.mediaMetadata !== undefined ? { mediaMetadata: normalizeMetadata(post.mediaMetadata, replacements) } : {}),
      likesCount: post._count.likes,
      commentsCount: post._count.comments,
      isLikedByCurrentUser: liked.has(post.id),
      isBookmarkedByCurrentUser: bookmarks.has(post.id),
      isLiked: liked.has(post.id),
      isSaved: bookmarks.has(post.id),
    };
  });
}
export async function enrichComments<T extends { id: string; _count: { likes: number; replies: number } }>(comments: T[], userId?: string) {
  const likes = userId && comments.length ? await prisma.commentLike.findMany({ where: { userId, commentId: { in: comments.map(c => c.id) } }, select: { commentId: true } }) : [];
  const liked = new Set(likes.map(l => l.commentId));
  return comments.map(c => ({ ...c, likesCount: c._count.likes, repliesCount: c._count.replies, isLikedByCurrentUser: liked.has(c.id) }));
}
