import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';

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
export async function enrichPosts<T extends { id: string; _count: { likes: number; comments: number } }>(posts: T[], userId?: string) {
  const ids = posts.map(p => p.id);
  const [likes, saved] = userId && ids.length ? await Promise.all([
    prisma.like.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
    prisma.savedPost.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
  ]) : [[], []];
  const liked = new Set(likes.map(l => l.postId)), bookmarks = new Set(saved.map(s => s.postId));
  return posts.map(p => ({ ...p, likesCount: p._count.likes, commentsCount: p._count.comments,
    isLikedByCurrentUser: liked.has(p.id), isBookmarkedByCurrentUser: bookmarks.has(p.id),
    isLiked: liked.has(p.id), isSaved: bookmarks.has(p.id) }));
}
export async function enrichComments<T extends { id: string; _count: { likes: number; replies: number } }>(comments: T[], userId?: string) {
  const likes = userId && comments.length ? await prisma.commentLike.findMany({ where: { userId, commentId: { in: comments.map(c => c.id) } }, select: { commentId: true } }) : [];
  const liked = new Set(likes.map(l => l.commentId));
  return comments.map(c => ({ ...c, likesCount: c._count.likes, repliesCount: c._count.replies, isLikedByCurrentUser: liked.has(c.id) }));
}
